-- ============================================================
-- migration_v235 — ONE visibility rule for expenses: expenses_visible
--
-- v234 hid soft-deleted expenses from app roles with a RESTRICTIVE RLS
-- policy, but SECURITY DEFINER functions bypass RLS, so each of the 7
-- report functions that sum expenses carried its own manual
-- `deleted_at IS NULL`. Two rules, and a new function could forget the
-- second one. This view is the single rule: a view's WHERE applies even
-- inside SECURITY DEFINER bodies (unlike RLS). The 7 report functions below
-- are v234's bodies verbatim except FROM expenses -> FROM expenses_visible
-- (the manual filter is dropped; the view owns it). Three more functions
-- that READ expenses (run_reconciliation, attach_transaction_proof,
-- delete_transaction_proof) are repointed the same way so the CI guard needs
-- no allowlist beyond the soft-delete/restore RPCs, which must see tombstones:
-- a soft-deleted expense is now also invisible to the integrity checks and
-- cannot receive/lose a receipt photo.
--
-- v234's restrictive policy on the expenses table STAYS (defense in depth).
--
-- COLUMNS ARE EXPLICIT, never select *. CONSEQUENCE: any later migration
-- that adds a column to `expenses` must re-issue this view
-- (CREATE OR REPLACE VIEW can only append columns at the end), or functions
-- reading the new column through the view will not see it.
-- __tests__/expense-visibility-guard.test.ts fails the build if a function
-- reads the expenses table directly.
--
-- The view runs with its owner's rights (it bypasses expenses' RLS by
-- design, like the definer functions that use it), so it is NOT granted to
-- app roles: they must never be able to select from it directly.
-- ============================================================

CREATE OR REPLACE VIEW expenses_visible AS
  SELECT id, business_id, amount, description, category, date, status, created_by, approved_by, approved_at, created_at, updated_at, due_date, note, product_id, purchase_order_id, proof_image_url, proof_image_width, proof_image_height, proof_attached_by, proof_attached_at
  FROM expenses
  WHERE deleted_at IS NULL;

REVOKE ALL ON expenses_visible FROM PUBLIC, anon, authenticated;


-- get_business_kpis: reads expenses_visible (1 read(s))
CREATE OR REPLACE FUNCTION public.get_business_kpis(p_business_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today_start     timestamptz := date_trunc('day', now());
  v_yesterday_start timestamptz := date_trunc('day', now()) - interval '1 day';
  v_tomorrow_start  timestamptz := date_trunc('day', now()) + interval '1 day';
  v_month_start     timestamptz := date_trunc('month', now());
  v_today_date      text        := to_char(date_trunc('day', now()), 'YYYY-MM-DD');
  v_month_date      text        := to_char(date_trunc('month', now()), 'YYYY-MM-DD');
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM memberships
    WHERE business_id = p_business_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  RETURN jsonb_build_object(
    'revenue_today', COALESCE((
      SELECT SUM(total_amount) FROM sale_orders
      WHERE business_id = p_business_id AND status = 'paye'
        AND paid_at >= v_today_start AND paid_at < v_tomorrow_start
    ), 0),
    'revenue_yesterday', COALESCE((
      SELECT SUM(total_amount) FROM sale_orders
      WHERE business_id = p_business_id AND status = 'paye'
        AND paid_at >= v_yesterday_start AND paid_at < v_today_start
    ), 0),
    'revenue_month', COALESCE((
      SELECT SUM(total_amount) FROM sale_orders
      WHERE business_id = p_business_id AND status = 'paye'
        AND paid_at >= v_month_start
    ), 0),
    'sales_today', COALESCE((
      SELECT COUNT(*) FROM sale_orders
      WHERE business_id = p_business_id AND status IN ('paye', 'credit')
        AND sale_date = v_today_date
    ), 0),
    'credit_total', COALESCE((
      SELECT SUM(so.total_amount - COALESCE(p.paid, 0))
      FROM sale_orders so
      LEFT JOIN (
        SELECT order_id, SUM(amount) AS paid
        FROM payments
        WHERE business_id = p_business_id
        GROUP BY order_id
      ) p ON p.order_id = so.id
      WHERE so.business_id = p_business_id
        AND so.status = 'credit'
        AND so.total_amount - COALESCE(p.paid, 0) > 0.01
    ), 0),
    'credit_count', COALESCE((
      SELECT COUNT(so.id)
      FROM sale_orders so
      LEFT JOIN (
        SELECT order_id, SUM(amount) AS paid
        FROM payments
        WHERE business_id = p_business_id
        GROUP BY order_id
      ) p ON p.order_id = so.id
      WHERE so.business_id = p_business_id
        AND so.status = 'credit'
        AND so.total_amount - COALESCE(p.paid, 0) > 0.01
    ), 0),
    'expenses_month', COALESCE((
      SELECT SUM(amount) FROM expenses_visible
      WHERE business_id = p_business_id AND status = 'approuve'
        AND date >= v_month_date
    ), 0)
  );
END;
$function$;

-- get_product_stats: reads expenses_visible (1 read(s))
CREATE OR REPLACE FUNCTION public.get_product_stats(p_product_id uuid, p_business_id uuid, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cost_price        bigint;
  v_revenue           bigint;
  v_capital           bigint;
  v_qty_lost          bigint;
  v_linked_expenses   bigint;
  v_has_unknown_cost  boolean;
BEGIN
  IF NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé';
  END IF;

  -- [v232] returns capital (qty x cost_price) and profit: cost data a vendeur
  -- cannot read from the tables since v193. Only the catalogue's admin/manager
  -- (and investisseur, who has a scoped cost_price SELECT, v66) screens call it.
  IF COALESCE(get_role(p_business_id), '') = 'vendeur' THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  SELECT cost_price INTO v_cost_price
  FROM products
  WHERE id = p_product_id AND business_id = p_business_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Produit introuvable';
  END IF;

  -- Revenue: real, closed sales only (v152) — matches
  -- get_reports_snapshot / get_best_sellers, not "everything not cancelled".
  SELECT COALESCE(SUM(sl.unit_price * sl.qty), 0)
  INTO v_revenue
  FROM so_lines sl
  JOIN sale_orders so ON so.id = sl.order_id
  WHERE sl.product_id = p_product_id
    AND so.business_id = p_business_id
    AND so.status IN ('paye', 'credit')
    AND (p_since IS NULL OR so.created_at >= p_since);

  -- Capital (COGS): same status fix — snapshotted cost, fall back to
  -- variant then product cost.
  SELECT COALESCE(SUM(
    sl.qty * COALESCE(sl.cost_price_at_sale, pv.cost_price, v_cost_price)
  ), 0)
  INTO v_capital
  FROM so_lines sl
  JOIN sale_orders so ON so.id = sl.order_id
  LEFT JOIN product_variants pv ON pv.id = sl.variant_id
  WHERE sl.product_id = p_product_id
    AND so.business_id = p_business_id
    AND so.status IN ('paye', 'credit')
    AND (p_since IS NULL OR so.created_at >= p_since);

  -- Unknown-cost flag (v222): any sold line in the period whose cost cannot
  -- be resolved to a real positive number makes the whole profit figure
  -- untrustworthy — return it as NULL (client shows "—"). This catches both
  -- (a) v221 NULL-cost products and (b) quick-sale "Vente rapide" lines,
  -- whose cost_price_at_sale is NULL and whose system placeholder has
  -- cost_price = 0 (a fake, never a real recorded purchase cost).
  SELECT EXISTS (
    SELECT 1
    FROM so_lines sl
    JOIN sale_orders so ON so.id = sl.order_id
    LEFT JOIN product_variants pv ON pv.id = sl.variant_id
    WHERE sl.product_id = p_product_id
      AND so.business_id = p_business_id
      AND so.status IN ('paye', 'credit')
      AND (p_since IS NULL OR so.created_at >= p_since)
      AND (
        COALESCE(sl.cost_price_at_sale, pv.cost_price, v_cost_price) IS NULL
        OR COALESCE(sl.cost_price_at_sale, pv.cost_price, v_cost_price) <= 0
      )
  )
  INTO v_has_unknown_cost;

  -- Losses
  SELECT COALESCE(SUM(qty), 0)
  INTO v_qty_lost
  FROM stock_moves
  WHERE product_id = p_product_id
    AND business_id = p_business_id
    AND type = 'perte'
    AND (p_since IS NULL OR created_at >= p_since);

  v_capital := v_capital + v_qty_lost * v_cost_price;

  -- Linked approved expenses
  SELECT COALESCE(SUM(amount), 0)
  INTO v_linked_expenses
  FROM expenses_visible
  WHERE product_id   = p_product_id
    AND business_id  = p_business_id
    AND status       = 'approuve'
    AND (p_since IS NULL OR date >= p_since::date);

  RETURN json_build_object(
    'revenue',          v_revenue,
    'capital',          v_capital,
    'linked_expenses',  v_linked_expenses,
    'profit',           CASE WHEN v_has_unknown_cost THEN NULL
                             ELSE v_revenue - v_capital - v_linked_expenses
                        END
  );
END;
$function$;

-- get_dashboard_kpis: reads expenses_visible (1 read(s))
CREATE OR REPLACE FUNCTION public.get_dashboard_kpis(p_business_id uuid, p_today date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today          date        := COALESCE(p_today, CURRENT_DATE);
  v_yesterday      date        := v_today - 1;
  v_month_start    date        := date_trunc('month', v_today)::date;
  v_today_ts       timestamptz := v_today::timestamptz;
  v_yest_ts        timestamptz := v_yesterday::timestamptz;
  v_month_ts       timestamptz := v_month_start::timestamptz;

  v_revenue_today     bigint := 0;
  v_revenue_yesterday bigint := 0;
  v_revenue_month     bigint := 0;
  v_sales_today       int    := 0;
  v_credit_total      bigint := 0;
  v_credit_count      int    := 0;
  v_expenses_month    bigint := 0;
  v_low_stock         int    := 0;
  v_first_sale_at     timestamptz;
  -- [v232] a vendeur's Accueil is THEIR numbers: every sale/expense aggregate
  -- below is narrowed to their own rows (NULL = no narrowing: admin/manager/
  -- investisseur). Mirrors RLS (sale_orders: seller_id = auth.uid();
  -- expenses: created_by = auth.uid()), which this SECURITY DEFINER bypasses.
  v_seller            uuid;
BEGIN
  IF NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF get_role(p_business_id) = 'vendeur' THEN
    v_seller := auth.uid();
  END IF;

  -- Count today — every non-annulée sale dated today (matches
  -- computeLocalKpis: status !== 'annule' AND COALESCE(sale_date,
  -- created_at::date) === today). Credit sales count; they are sales.
  SELECT COUNT(*)::int
  INTO v_sales_today
  FROM sale_orders
  WHERE business_id = p_business_id
    AND (v_seller IS NULL OR seller_id = v_seller)
    AND status <> 'annule'
    AND COALESCE(sale_date, created_at::date) = v_today;

  -- Revenue today — only cash (non-credit) sales, same local formula
  -- (todaySales.filter(s => !s.is_credit)).
  SELECT COALESCE(SUM(total_amount - COALESCE(discount_amount, 0)), 0)
  INTO v_revenue_today
  FROM sale_orders
  WHERE business_id = p_business_id
    AND (v_seller IS NULL OR seller_id = v_seller)
    AND status <> 'annule'
    AND COALESCE(sale_date, created_at::date) = v_today
    AND NOT is_credit;

  -- Revenue yesterday
  SELECT COALESCE(SUM(total_amount - COALESCE(discount_amount, 0)), 0)
  INTO v_revenue_yesterday
  FROM sale_orders
  WHERE business_id = p_business_id
    AND (v_seller IS NULL OR seller_id = v_seller)
    AND status      = 'paye'
    AND paid_at    >= v_yest_ts
    AND paid_at     < v_today_ts;

  -- Revenue this month
  SELECT COALESCE(SUM(total_amount - COALESCE(discount_amount, 0)), 0)
  INTO v_revenue_month
  FROM sale_orders
  WHERE business_id = p_business_id
    AND (v_seller IS NULL OR seller_id = v_seller)
    AND status      = 'paye'
    AND paid_at    >= v_month_ts;

  -- Lifetime — the business's very first real sale ever, regardless of
  -- month/today. NULL if it has never made one.
  SELECT MIN(paid_at) INTO v_first_sale_at
  FROM sale_orders
  WHERE business_id = p_business_id
    AND status      = 'paye';

  -- Credit total (remaining owed) + distinct debtor count
  WITH paid_per_order AS (
    SELECT p.order_id, SUM(p.amount) AS total_paid
    FROM payments p
    WHERE p.order_id IN (
      SELECT id FROM sale_orders
      WHERE business_id = p_business_id AND status = 'credit'
        AND (v_seller IS NULL OR seller_id = v_seller)
    )
    GROUP BY p.order_id
  ),
  credit_remaining AS (
    SELECT
      so.customer_name,
      (so.total_amount
        - COALESCE(so.discount_amount, 0)
        - COALESCE(ppo.total_paid, 0)) AS remaining
    FROM sale_orders so
    LEFT JOIN paid_per_order ppo ON ppo.order_id = so.id
    WHERE so.business_id = p_business_id
      AND so.status      = 'credit'
      AND (v_seller IS NULL OR so.seller_id = v_seller)
  )
  SELECT
    COALESCE(SUM(GREATEST(0, remaining)), 0),
    COUNT(DISTINCT customer_name) FILTER (WHERE customer_name IS NOT NULL AND remaining > 1)
    + COUNT(*)                    FILTER (WHERE customer_name IS NULL     AND remaining > 1)
  INTO v_credit_total, v_credit_count
  FROM credit_remaining;

  -- Approved expenses this month
  SELECT COALESCE(SUM(amount), 0)
  INTO v_expenses_month
  FROM expenses_visible
  WHERE business_id = p_business_id
    AND (v_seller IS NULL OR created_by = v_seller)
    AND status      = 'approuve'
    AND date       >= v_month_start;

  -- Low-stock count
  SELECT COUNT(*) INTO v_low_stock FROM (
    SELECT id FROM products
    WHERE business_id  = p_business_id
      AND NOT archived
      AND NOT has_variants
      AND reorder_level > 0
      AND stock_qty    <= reorder_level
    UNION ALL
    SELECT pv.id FROM product_variants pv
    WHERE pv.business_id = p_business_id
      AND NOT pv.archived
      AND pv.reorder_level > 0
      AND pv.stock_qty    <= pv.reorder_level
  ) sub;

  RETURN jsonb_build_object(
    'revenue_today',     v_revenue_today,
    'revenue_yesterday', v_revenue_yesterday,
    'revenue_month',     v_revenue_month,
    'sales_today',       v_sales_today,
    'credit_total',      v_credit_total,
    'credit_count',      v_credit_count,
    'expenses_month',    v_expenses_month,
    'low_stock',         v_low_stock,
    'first_sale_at',     v_first_sale_at
  );
END;
$function$;

-- get_financial_snapshot: reads expenses_visible (2 read(s))
CREATE OR REPLACE FUNCTION public.get_financial_snapshot()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today       date := CURRENT_DATE;
  v_month_start date := date_trunc('month', v_today)::date;
  v_result      jsonb;
BEGIN
  WITH currencies AS (
    SELECT DISTINCT currency FROM businesses
  ),
  today_rev AS (
    SELECT b.currency, SUM(so.total_amount - so.discount_amount) AS revenue
    FROM sale_orders so JOIN businesses b ON b.id = so.business_id
    WHERE so.status IN ('paye','credit') AND so.created_at >= v_today
    GROUP BY b.currency
  ),
  today_cogs AS (
    SELECT b.currency, SUM(sl.qty * COALESCE(sl.cost_price_at_sale,0)) AS cogs
    FROM so_lines sl
    JOIN sale_orders so ON so.id = sl.order_id
    JOIN businesses b   ON b.id  = so.business_id
    WHERE so.status IN ('paye','credit') AND so.created_at >= v_today
    GROUP BY b.currency
  ),
  today_exp AS (
    SELECT b.currency, SUM(e.amount) AS expenses
    FROM expenses_visible e JOIN businesses b ON b.id = e.business_id
    WHERE e.status = 'approuve' AND e.date >= v_today
    GROUP BY b.currency
  ),
  month_rev AS (
    SELECT b.currency, SUM(so.total_amount - so.discount_amount) AS revenue
    FROM sale_orders so JOIN businesses b ON b.id = so.business_id
    WHERE so.status IN ('paye','credit') AND so.created_at >= v_month_start
    GROUP BY b.currency
  ),
  month_cogs AS (
    SELECT b.currency, SUM(sl.qty * COALESCE(sl.cost_price_at_sale,0)) AS cogs
    FROM so_lines sl
    JOIN sale_orders so ON so.id = sl.order_id
    JOIN businesses b   ON b.id  = so.business_id
    WHERE so.status IN ('paye','credit') AND so.created_at >= v_month_start
    GROUP BY b.currency
  ),
  month_exp AS (
    SELECT b.currency, SUM(e.amount) AS expenses
    FROM expenses_visible e JOIN businesses b ON b.id = e.business_id
    WHERE e.status = 'approuve' AND e.date >= v_month_start
    GROUP BY b.currency
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'currency', c.currency,
      'today', jsonb_build_object(
        'revenue',    COALESCE(tr.revenue, 0),
        'cogs',       COALESCE(tc.cogs, 0),
        'expenses',   COALESCE(te.expenses, 0),
        'net_profit', COALESCE(tr.revenue, 0) - COALESCE(tc.cogs, 0) - COALESCE(te.expenses, 0)
      ),
      'month_to_date', jsonb_build_object(
        'revenue',    COALESCE(mr.revenue, 0),
        'cogs',       COALESCE(mc.cogs, 0),
        'expenses',   COALESCE(me.expenses, 0),
        'net_profit', COALESCE(mr.revenue, 0) - COALESCE(mc.cogs, 0) - COALESCE(me.expenses, 0)
      )
    )
    ORDER BY COALESCE(mr.revenue, 0) DESC
  )
  INTO v_result
  FROM currencies c
  LEFT JOIN today_rev  tr ON tr.currency = c.currency
  LEFT JOIN today_cogs tc ON tc.currency = c.currency
  LEFT JOIN today_exp  te ON te.currency = c.currency
  LEFT JOIN month_rev  mr ON mr.currency = c.currency
  LEFT JOIN month_cogs mc ON mc.currency = c.currency
  LEFT JOIN month_exp  me ON me.currency = c.currency
  WHERE COALESCE(mr.revenue, 0) != 0 OR COALESCE(tr.revenue, 0) != 0;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$function$;

-- get_reports_snapshot: reads expenses_visible (3 read(s))
CREATE OR REPLACE FUNCTION public.get_reports_snapshot(p_business_id uuid, p_period_days integer, p_role text, p_user_id uuid DEFAULT NULL::uuid, p_today date DEFAULT CURRENT_DATE)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_period_start date := p_today - p_period_days;

  -- Server-derived role/identity — never trust p_role/p_user_id directly
  -- for an authenticated caller (see fix note above).
  v_role               text;
  v_user_id            uuid;

  -- Admin / manager / investisseur
  v_revenue            bigint := 0;
  v_cogs               bigint := 0;
  v_stock_losses       bigint := 0;
  v_gross_profit       bigint := 0;
  v_oper_expenses      bigint := 0;
  v_shipping_exp       bigint := 0;
  v_net_profit         bigint := 0;
  v_credit_outstanding bigint := 0;
  v_credit_count       int    := 0;
  v_order_count        int    := 0;
  v_cash_on_hand       bigint := 0;
  v_stock_value        bigint := 0;
  v_total_apports      bigint := 0;
  v_period_apports     bigint := 0;
  v_activity           jsonb  := '[]'::jsonb;
  v_top_sellers        jsonb  := '[]'::jsonb;

  -- Vendeur
  v_my_revenue         bigint := 0;
  v_my_sales_count     int    := 0;
  v_my_credit_pending  bigint := 0;
  v_my_credit_count    int    := 0;
  v_my_activity        jsonb  := '[]'::jsonb;

  -- Investisseur
  v_investor_balance   bigint := 0;
  v_my_total_invested  bigint := 0;
  v_my_period_apports  bigint := 0;
BEGIN
  -- Authenticated users must be members of the business.
  -- Service role (auth.uid() = NULL) may call this for internal reconciliation.
  IF auth.uid() IS NOT NULL AND NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF auth.uid() IS NOT NULL THEN
    -- Real user session: derive role/identity server-side. p_role/p_user_id
    -- as supplied by the client are ignored from here on.
    v_role    := get_role(p_business_id);
    v_user_id := auth.uid();
  ELSE
    -- Service-role call (nightly reconciliation etc.) — no membership/role
    -- of its own to derive from, so trust its own parameters as before.
    v_role    := p_role;
    v_user_id := p_user_id;
  END IF;

  -- ── Admin / manager / investisseur shared metrics ──────────────────────────

  IF v_role IN ('administrateur', 'manager', 'investisseur') THEN

    -- Revenue: earned when the sale was made (sale_date), not when cash arrived.
    -- Includes cash sales (paye) and unpaid credit sales (credit).
    SELECT
      COALESCE(SUM(so.total_amount - COALESCE(so.discount_amount, 0)), 0),
      COUNT(DISTINCT so.id)::int
    INTO v_revenue, v_order_count
    FROM sale_orders so
    WHERE so.business_id = p_business_id
      AND so.status IN ('paye', 'credit')
      AND so.sale_date >= v_period_start
      AND so.sale_date <= p_today;

    -- COGS: snapshotted cost at sale time (shipping already baked in via AVCO).
    -- Pre-v81 rows with NULL cost_price_at_sale are excluded (approximation risk).
    SELECT COALESCE(SUM(sl.qty * sl.cost_price_at_sale), 0)
    INTO v_cogs
    FROM so_lines sl
    JOIN sale_orders so ON so.id = sl.order_id
    WHERE so.business_id = p_business_id
      AND so.status IN ('paye', 'credit')
      AND so.sale_date >= v_period_start
      AND so.sale_date <= p_today
      AND sl.cost_price_at_sale IS NOT NULL;

    -- Stock losses: cost of units marked perte in the period.
    -- Uses current cost_price (no historical snapshot for losses).
    -- stock_moves is always product-level (no variant_id column exists there).
    SELECT COALESCE(SUM(
      sm.qty * COALESCE(p.cost_price, 0)
    ), 0)
    INTO v_stock_losses
    FROM stock_moves sm
    JOIN products p ON p.id = sm.product_id
    WHERE sm.business_id = p_business_id
      AND sm.type = 'perte'
      AND sm.created_at::date >= v_period_start
      AND sm.created_at::date <= p_today;

    -- Operating expenses in period.
    -- transport_achat excluded: already absorbed into cost_price via AVCO.
    SELECT COALESCE(SUM(e.amount), 0)
    INTO v_oper_expenses
    FROM expenses_visible e
    WHERE e.business_id = p_business_id
      AND e.status = 'approuve'
      AND (e.category IS NULL OR e.category <> 'transport_achat')
      AND e.date >= v_period_start
      AND e.date <= p_today;

    -- Shipping expenses shown as a separate informational line.
    -- NOT deducted from net_profit (already in COGS via AVCO).
    SELECT COALESCE(SUM(e.amount), 0)
    INTO v_shipping_exp
    FROM expenses_visible e
    WHERE e.business_id = p_business_id
      AND e.status = 'approuve'
      AND e.category = 'transport_achat'
      AND e.date >= v_period_start
      AND e.date <= p_today;

    v_gross_profit := v_revenue - v_cogs - v_stock_losses;
    v_net_profit   := v_gross_profit - v_oper_expenses;

    -- Credit outstanding (all-time, not period-specific).
    WITH paid_per_order AS (
      SELECT p.order_id, SUM(p.amount) AS total_paid
      FROM payments p
      INNER JOIN sale_orders so ON so.id = p.order_id
      WHERE so.business_id = p_business_id AND so.status = 'credit'
      GROUP BY p.order_id
    )
    SELECT
      COALESCE(SUM(GREATEST(0,
        so.total_amount - COALESCE(so.discount_amount, 0)
        - COALESCE(ppo.total_paid, 0)
      )), 0),
      COUNT(*) FILTER (WHERE
        GREATEST(0,
          so.total_amount - COALESCE(so.discount_amount, 0) - COALESCE(ppo.total_paid, 0)
        ) > 100
      )::int
    INTO v_credit_outstanding, v_credit_count
    FROM sale_orders so
    LEFT JOIN paid_per_order ppo ON ppo.order_id = so.id
    WHERE so.business_id = p_business_id AND so.status = 'credit';

    -- Cash on hand: all-time position.
    -- = cash collected from sales (payments table)
    -- + capital injected by owners/investors
    -- − all approved expenses
    -- − supplier debt payments actually made
    -- − investor profit payouts confirmed
    SELECT
      COALESCE((SELECT SUM(amount)       FROM payments           WHERE business_id = p_business_id), 0)
      + COALESCE((SELECT SUM(amount)     FROM capital_injections WHERE business_id = p_business_id), 0)
      - COALESCE((SELECT SUM(amount)     FROM expenses_visible WHERE business_id = p_business_id AND status = 'approuve'), 0)
      - COALESCE((SELECT SUM(amount_cents) FROM supplier_payments WHERE business_id = p_business_id), 0)
      - COALESCE((SELECT SUM(paid_amount)  FROM investor_payouts  WHERE business_id = p_business_id AND status = 'paye'), 0)
    INTO v_cash_on_hand;

    -- Current inventory value: cost_price × stock_qty across all active products.
    SELECT
      COALESCE(SUM(CASE WHEN NOT has_variants THEN cost_price * stock_qty ELSE 0 END), 0)
      + COALESCE((
          SELECT SUM(pv.cost_price * pv.stock_qty)
          FROM product_variants pv
          WHERE pv.business_id = p_business_id AND NOT pv.archived AND pv.stock_qty > 0
        ), 0)
    INTO v_stock_value
    FROM products
    WHERE business_id = p_business_id AND NOT archived;

    -- Capital injections: all-time and within period.
    SELECT COALESCE(SUM(amount), 0)
    INTO v_total_apports
    FROM capital_injections
    WHERE business_id = p_business_id;

    SELECT COALESCE(SUM(amount), 0)
    INTO v_period_apports
    FROM capital_injections
    WHERE business_id = p_business_id
      AND injected_at::date >= v_period_start
      AND injected_at::date <= p_today;

    -- Activity chart: daily revenue by sale_date (for all periods).
    -- Frontend is responsible for bucketing daily data into weekly groups
    -- for the trimestre view — that is display logic, not financial math.
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object('date', gs.day::date::text, 'amount', COALESCE(daily.day_amount, 0))
      ORDER BY gs.day
    ), '[]'::jsonb)
    INTO v_activity
    FROM generate_series(v_period_start, p_today, '1 day'::interval) AS gs(day)
    LEFT JOIN (
      SELECT
        so.sale_date                                                     AS day,
        SUM(so.total_amount - COALESCE(so.discount_amount, 0))          AS day_amount
      FROM sale_orders so
      WHERE so.business_id = p_business_id
        AND so.status IN ('paye', 'credit')
        AND so.sale_date >= v_period_start
        AND so.sale_date <= p_today
      GROUP BY so.sale_date
    ) daily ON daily.day = gs.day::date;

    -- Top sellers leaderboard: revenue by seller in period (max 5).
    -- Name resolution mirrors stores/ventes.ts: membership display_name
    -- override, then profile name, then a generic fallback label.
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object('name', lb.seller_name, 'revenue', lb.seller_rev, 'count', lb.sale_count)
      ORDER BY lb.seller_rev DESC
    ), '[]'::jsonb)
    INTO v_top_sellers
    FROM (
      SELECT
        COALESCE(m.display_name, pr.name, 'Vendeur')            AS seller_name,
        SUM(so.total_amount - COALESCE(so.discount_amount, 0)) AS seller_rev,
        COUNT(*)::int                                           AS sale_count
      FROM sale_orders so
      LEFT JOIN memberships m ON m.business_id = so.business_id AND m.user_id = so.seller_id
      LEFT JOIN profiles    pr ON pr.id = so.seller_id
      WHERE so.business_id = p_business_id
        AND so.status IN ('paye', 'credit')
        AND so.sale_date >= v_period_start
        AND so.sale_date <= p_today
      GROUP BY so.seller_id, COALESCE(m.display_name, pr.name, 'Vendeur')
      ORDER BY seller_rev DESC
      LIMIT 5
    ) lb;

  END IF;

  -- ── Vendeur personal stats ─────────────────────────────────────────────────

  IF v_role = 'vendeur' THEN

    SELECT
      COALESCE(SUM(so.total_amount - COALESCE(so.discount_amount, 0)), 0),
      COUNT(*)::int
    INTO v_my_revenue, v_my_sales_count
    FROM sale_orders so
    WHERE so.business_id = p_business_id
      AND so.seller_id   = v_user_id
      AND so.status IN ('paye', 'credit')
      AND so.sale_date >= v_period_start
      AND so.sale_date <= p_today;

    -- Personal credit outstanding (active credit sales by this seller).
    WITH paid_per_order AS (
      SELECT p.order_id, SUM(p.amount) AS total_paid
      FROM payments p
      INNER JOIN sale_orders so ON so.id = p.order_id
      WHERE so.business_id = p_business_id
        AND so.seller_id   = v_user_id
        AND so.status = 'credit'
      GROUP BY p.order_id
    )
    SELECT
      COALESCE(SUM(GREATEST(0,
        so.total_amount - COALESCE(so.discount_amount, 0) - COALESCE(ppo.total_paid, 0)
      )), 0),
      COUNT(*) FILTER (WHERE
        GREATEST(0,
          so.total_amount - COALESCE(so.discount_amount, 0) - COALESCE(ppo.total_paid, 0)
        ) > 100
      )::int
    INTO v_my_credit_pending, v_my_credit_count
    FROM sale_orders so
    LEFT JOIN paid_per_order ppo ON ppo.order_id = so.id
    WHERE so.business_id = p_business_id
      AND so.seller_id   = v_user_id
      AND so.status = 'credit';

    -- Personal activity chart (daily, by sale_date).
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object('date', gs.day::date::text, 'amount', COALESCE(daily.day_amount, 0))
      ORDER BY gs.day
    ), '[]'::jsonb)
    INTO v_my_activity
    FROM generate_series(v_period_start, p_today, '1 day'::interval) AS gs(day)
    LEFT JOIN (
      SELECT
        so.sale_date                                                     AS day,
        SUM(so.total_amount - COALESCE(so.discount_amount, 0))          AS day_amount
      FROM sale_orders so
      WHERE so.business_id = p_business_id
        AND so.seller_id   = v_user_id
        AND so.status IN ('paye', 'credit')
        AND so.sale_date >= v_period_start
        AND so.sale_date <= p_today
      GROUP BY so.sale_date
    ) daily ON daily.day = gs.day::date;

  END IF;

  -- ── Investisseur personal stats ────────────────────────────────────────────

  IF v_role = 'investisseur' THEN

    SELECT COALESCE(balance, 0)
    INTO v_investor_balance
    FROM investor_balance
    WHERE business_id = p_business_id AND investor_id = v_user_id;

    SELECT COALESCE(SUM(amount), 0)
    INTO v_my_total_invested
    FROM capital_injections
    WHERE business_id  = p_business_id
      AND injected_by_id = v_user_id;

    SELECT COALESCE(SUM(amount), 0)
    INTO v_my_period_apports
    FROM capital_injections
    WHERE business_id  = p_business_id
      AND injected_by_id = v_user_id
      AND injected_at::date >= v_period_start
      AND injected_at::date <= p_today;

  END IF;

  RETURN jsonb_build_object(
    'role',               v_role,
    'period_days',        p_period_days,
    'period_start',       v_period_start::text,
    -- Shared (admin/manager/investisseur)
    'revenue',            v_revenue,
    'cogs',               v_cogs,
    'stock_losses',       v_stock_losses,
    'gross_profit',       v_gross_profit,
    'operating_expenses', v_oper_expenses,
    'shipping_expenses',  v_shipping_exp,
    'net_profit',         v_net_profit,
    'credit_outstanding', v_credit_outstanding,
    'credit_count',       v_credit_count,
    'period_order_count', v_order_count,
    'cash_on_hand',       v_cash_on_hand,
    'stock_value',        v_stock_value,
    'total_apports',      v_total_apports,
    'period_apports',     v_period_apports,
    'activity',           v_activity,
    'top_sellers',        v_top_sellers,
    -- Vendeur
    'my_revenue',         v_my_revenue,
    'my_sales_count',     v_my_sales_count,
    'my_credit_pending',  v_my_credit_pending,
    'my_credit_count',    v_my_credit_count,
    'my_activity',        v_my_activity,
    -- Investisseur
    'investor_balance',   v_investor_balance,
    'my_total_invested',  v_my_total_invested,
    'my_period_apports',  v_my_period_apports
  );
END;
$function$;

-- get_period_report: reads expenses_visible (2 read(s))
CREATE OR REPLACE FUNCTION public.get_period_report(p_business_id uuid, p_period_start date, p_period_end date, p_role text, p_user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_role    text;
  v_user_id uuid;

  -- Admin / manager / investisseur
  v_revenue             bigint  := 0;
  v_cogs                bigint  := 0;
  v_unknown_cost_revenue bigint := 0;  -- v220: revenue of lines without a purchase cost
  v_sales_without_cost  int     := 0;  -- v220: distinct orders with ≥1 unknown-cost line
  v_stock_losses        bigint  := 0;
  v_oper_expenses       bigint  := 0;
  v_net_profit          bigint  := 0;
  v_sales_count         int     := 0;
  v_units_sold          numeric := 0;
  v_credit_outstanding  bigint  := 0;
  v_credit_count        int     := 0;
  v_cash_on_hand        bigint  := 0;
  v_daily               jsonb   := '[]'::jsonb;

  -- Vendeur
  v_my_sales_count    int     := 0;
  v_my_units_sold     numeric := 0;
  v_my_credit_pending bigint  := 0;
  v_my_credit_count   int     := 0;
  v_my_daily          jsonb   := '[]'::jsonb;

  -- Investisseur
  v_investor_balance  bigint := 0;
  v_my_total_invested bigint := 0;
BEGIN
  IF p_period_end < p_period_start THEN
    RAISE EXCEPTION 'Période invalide' USING ERRCODE = 'P0001';
  END IF;

  IF auth.uid() IS NOT NULL AND NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF auth.uid() IS NOT NULL THEN
    v_role    := get_role(p_business_id);
    v_user_id := auth.uid();
  ELSE
    v_role    := p_role;
    v_user_id := p_user_id;
  END IF;

  -- ── Admin / manager / investisseur ──────────────────────────────────────

  IF v_role IN ('administrateur', 'manager', 'investisseur') THEN

    SELECT
      COALESCE(SUM(so.total_amount - COALESCE(so.discount_amount, 0)), 0),
      COUNT(*)::int
    INTO v_revenue, v_sales_count
    FROM sale_orders so
    WHERE so.business_id = p_business_id
      AND so.status IN ('paye', 'credit')
      AND so.sale_date >= p_period_start
      AND so.sale_date <= p_period_end;

    SELECT COALESCE(SUM(sl.qty), 0)
    INTO v_units_sold
    FROM so_lines sl
    JOIN sale_orders so ON so.id = sl.order_id
    WHERE so.business_id = p_business_id
      AND so.status IN ('paye', 'credit')
      AND so.sale_date >= p_period_start
      AND so.sale_date <= p_period_end;

    SELECT COALESCE(SUM(sl.qty * sl.cost_price_at_sale), 0)
    INTO v_cogs
    FROM so_lines sl
    JOIN sale_orders so ON so.id = sl.order_id
    WHERE so.business_id = p_business_id
      AND so.status IN ('paye', 'credit')
      AND so.sale_date >= p_period_start
      AND so.sale_date <= p_period_end
      AND sl.cost_price_at_sale IS NOT NULL;

    -- v220 — unknown-cost lines: their revenue currently lands fully in
    -- profit (v_cogs skips them), which overstates Bénéfice cumulé. Compute
    -- both their line-level revenue (to subtract from profit) and the number
    -- of distinct orders affected (to show the caveat on screen).
    SELECT
      COALESCE(SUM(sl.qty * sl.unit_price), 0),
      COUNT(DISTINCT so.id)::int
    INTO v_unknown_cost_revenue, v_sales_without_cost
    FROM so_lines sl
    JOIN sale_orders so ON so.id = sl.order_id
    WHERE so.business_id = p_business_id
      AND so.status IN ('paye', 'credit')
      AND so.sale_date >= p_period_start
      AND so.sale_date <= p_period_end
      AND sl.cost_price_at_sale IS NULL;

    SELECT COALESCE(SUM(sm.qty * COALESCE(p.cost_price, 0)), 0)
    INTO v_stock_losses
    FROM stock_moves sm
    JOIN products p ON p.id = sm.product_id
    WHERE sm.business_id = p_business_id
      AND sm.type = 'perte'
      AND sm.created_at::date >= p_period_start
      AND sm.created_at::date <= p_period_end;

    SELECT COALESCE(SUM(e.amount), 0)
    INTO v_oper_expenses
    FROM expenses_visible e
    WHERE e.business_id = p_business_id
      AND e.status = 'approuve'
      AND (e.category IS NULL OR e.category <> 'transport_achat')
      AND e.date >= p_period_start
      AND e.date <= p_period_end;

    -- v220: exclude unknown-cost revenue so profit only reflects lines with
    -- a real purchase cost.
    v_net_profit := v_revenue - v_cogs - v_unknown_cost_revenue - v_stock_losses - v_oper_expenses;

    -- Credit outstanding ("dettes clients") — all-time live balance, not
    -- period-bound, same semantics as get_reports_snapshot.
    WITH paid_per_order AS (
      SELECT p.order_id, SUM(p.amount) AS total_paid
      FROM payments p
      INNER JOIN sale_orders so ON so.id = p.order_id
      WHERE so.business_id = p_business_id AND so.status = 'credit'
      GROUP BY p.order_id
    )
    SELECT
      COALESCE(SUM(GREATEST(0,
        so.total_amount - COALESCE(so.discount_amount, 0) - COALESCE(ppo.total_paid, 0)
      )), 0),
      COUNT(*) FILTER (WHERE
        GREATEST(0,
          so.total_amount - COALESCE(so.discount_amount, 0) - COALESCE(ppo.total_paid, 0)
        ) > 100
      )::int
    INTO v_credit_outstanding, v_credit_count
    FROM sale_orders so
    LEFT JOIN paid_per_order ppo ON ppo.order_id = so.id
    WHERE so.business_id = p_business_id AND so.status = 'credit';

    -- Cash on hand — all-time position, identical formula to get_reports_snapshot.
    SELECT
      COALESCE((SELECT SUM(amount)         FROM payments             WHERE business_id = p_business_id), 0)
      + COALESCE((SELECT SUM(amount)       FROM capital_injections   WHERE business_id = p_business_id), 0)
      - COALESCE((SELECT SUM(amount)       FROM expenses_visible WHERE business_id = p_business_id AND status = 'approuve'), 0)
      - COALESCE((SELECT SUM(amount_cents) FROM supplier_payments    WHERE business_id = p_business_id), 0)
      - COALESCE((SELECT SUM(paid_amount)  FROM investor_payouts     WHERE business_id = p_business_id AND status = 'paye'), 0)
    INTO v_cash_on_hand;

    -- Daily heatmap series — amount/sales_count from sale_orders alone
    -- (no line join, so no fan-out risk), units_sold from a *separate*
    -- so_lines-joined subquery, merged back on the date. See header note.
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'date',        gs.day::date::text,
        'amount',      COALESCE(rev.day_amount, 0),
        'sales_count', COALESCE(rev.day_sales, 0),
        'units_sold',  COALESCE(units.day_units, 0)
      ) ORDER BY gs.day
    ), '[]'::jsonb)
    INTO v_daily
    FROM generate_series(p_period_start, p_period_end, '1 day'::interval) AS gs(day)
    LEFT JOIN (
      SELECT
        so.sale_date                                            AS day,
        SUM(so.total_amount - COALESCE(so.discount_amount, 0))  AS day_amount,
        COUNT(*)                                                 AS day_sales
      FROM sale_orders so
      WHERE so.business_id = p_business_id
        AND so.status IN ('paye', 'credit')
        AND so.sale_date >= p_period_start
        AND so.sale_date <= p_period_end
      GROUP BY so.sale_date
    ) rev ON rev.day = gs.day::date
    LEFT JOIN (
      SELECT so.sale_date AS day, SUM(sl.qty) AS day_units
      FROM so_lines sl
      JOIN sale_orders so ON so.id = sl.order_id
      WHERE so.business_id = p_business_id
        AND so.status IN ('paye', 'credit')
        AND so.sale_date >= p_period_start
        AND so.sale_date <= p_period_end
      GROUP BY so.sale_date
    ) units ON units.day = gs.day::date;

  END IF;

  -- ── Vendeur personal stats ─────────────────────────────────────────────

  IF v_role = 'vendeur' THEN

    SELECT COUNT(*)::int
    INTO v_my_sales_count
    FROM sale_orders so
    WHERE so.business_id = p_business_id
      AND so.seller_id   = v_user_id
      AND so.status IN ('paye', 'credit')
      AND so.sale_date >= p_period_start
      AND so.sale_date <= p_period_end;

    SELECT COALESCE(SUM(sl.qty), 0)
    INTO v_my_units_sold
    FROM so_lines sl
    JOIN sale_orders so ON so.id = sl.order_id
    WHERE so.business_id = p_business_id
      AND so.seller_id   = v_user_id
      AND so.status IN ('paye', 'credit')
      AND so.sale_date >= p_period_start
      AND so.sale_date <= p_period_end;

    WITH paid_per_order AS (
      SELECT p.order_id, SUM(p.amount) AS total_paid
      FROM payments p
      INNER JOIN sale_orders so ON so.id = p.order_id
      WHERE so.business_id = p_business_id
        AND so.seller_id   = v_user_id
        AND so.status = 'credit'
      GROUP BY p.order_id
    )
    SELECT
      COALESCE(SUM(GREATEST(0,
        so.total_amount - COALESCE(so.discount_amount, 0) - COALESCE(ppo.total_paid, 0)
      )), 0),
      COUNT(*) FILTER (WHERE
        GREATEST(0,
          so.total_amount - COALESCE(so.discount_amount, 0) - COALESCE(ppo.total_paid, 0)
        ) > 100
      )::int
    INTO v_my_credit_pending, v_my_credit_count
    FROM sale_orders so
    LEFT JOIN paid_per_order ppo ON ppo.order_id = so.id
    WHERE so.business_id = p_business_id
      AND so.seller_id   = v_user_id
      AND so.status = 'credit';

    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'date',        gs.day::date::text,
        'amount',      COALESCE(rev.day_amount, 0),
        'sales_count', COALESCE(rev.day_sales, 0),
        'units_sold',  COALESCE(units.day_units, 0)
      ) ORDER BY gs.day
    ), '[]'::jsonb)
    INTO v_my_daily
    FROM generate_series(p_period_start, p_period_end, '1 day'::interval) AS gs(day)
    LEFT JOIN (
      SELECT
        so.sale_date                                            AS day,
        SUM(so.total_amount - COALESCE(so.discount_amount, 0))  AS day_amount,
        COUNT(*)                                                 AS day_sales
      FROM sale_orders so
      WHERE so.business_id = p_business_id
        AND so.seller_id   = v_user_id
        AND so.status IN ('paye', 'credit')
        AND so.sale_date >= p_period_start
        AND so.sale_date <= p_period_end
      GROUP BY so.sale_date
    ) rev ON rev.day = gs.day::date
    LEFT JOIN (
      SELECT so.sale_date AS day, SUM(sl.qty) AS day_units
      FROM so_lines sl
      JOIN sale_orders so ON so.id = sl.order_id
      WHERE so.business_id = p_business_id
        AND so.seller_id   = v_user_id
        AND so.status IN ('paye', 'credit')
        AND so.sale_date >= p_period_start
        AND so.sale_date <= p_period_end
      GROUP BY so.sale_date
    ) units ON units.day = gs.day::date;

  END IF;

  -- ── Investisseur personal stats ─────────────────────────────────────────

  IF v_role = 'investisseur' THEN

    SELECT COALESCE(balance, 0)
    INTO v_investor_balance
    FROM investor_balance
    WHERE business_id = p_business_id AND investor_id = v_user_id;

    SELECT COALESCE(SUM(amount), 0)
    INTO v_my_total_invested
    FROM capital_injections
    WHERE business_id    = p_business_id
      AND injected_by_id = v_user_id;

  END IF;

  RETURN jsonb_build_object(
    'role',               v_role,
    'period_start',       p_period_start::text,
    'period_end',         p_period_end::text,
    -- Shared (admin/manager/investisseur)
    'cash_on_hand',       v_cash_on_hand,
    'net_profit',         v_net_profit,
    'sales_count',        v_sales_count,
    'units_sold',         v_units_sold,
    'sales_without_cost', v_sales_without_cost,   -- v220
    'credit_outstanding', v_credit_outstanding,
    'credit_count',       v_credit_count,
    'daily',              v_daily,
    -- Vendeur
    'my_sales_count',     v_my_sales_count,
    'my_units_sold',      v_my_units_sold,
    'my_credit_pending',  v_my_credit_pending,
    'my_credit_count',    v_my_credit_count,
    'my_daily',           v_my_daily,
    -- Investisseur
    'investor_balance',   v_investor_balance,
    'my_total_invested',  v_my_total_invested
  );
END;
$function$;

-- run_display_checks: reads expenses_visible (2 read(s))
CREATE OR REPLACE FUNCTION public.run_display_checks(p_run_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN

  -- ── Check 69: Orders missing sale_date ───────────────────────────────────
  INSERT INTO reconciliation_findings
    (run_id, check_id, domain, check_name, severity,
     business_id, entity_type, entity_id, detail, affected_count)
  SELECT
    p_run_id, 69, 'Affichage', 'Vente sans date de vente', 'warning',
    so.business_id, 'sale_order', so.id,
    format('Vente %s: sale_date NULL — absente des rapports (filtrée par période)', so.id),
    1
  FROM sale_orders so
  WHERE so.sale_date IS NULL
    AND so.status NOT IN ('annule', 'brouillon');

  -- ── Check 70: Cash on hand negative ──────────────────────────────────────
  INSERT INTO reconciliation_findings
    (run_id, check_id, domain, check_name, severity,
     business_id, detail, affected_count)
  SELECT
    p_run_id, 70, 'Affichage', 'Argent disponible négatif', 'warning',
    b.id,
    format('"%s": argent disponible = %s centimes (sorties > entrées — vérifier dépenses ou apports manquants)',
      b.name, cash_balance),
    1
  FROM businesses b
  JOIN LATERAL (
    SELECT
      COALESCE((SELECT SUM(amount)         FROM payments         WHERE business_id = b.id), 0)
      + COALESCE((SELECT SUM(amount)       FROM capital_injections WHERE business_id = b.id), 0)
      - COALESCE((SELECT SUM(amount)       FROM expenses_visible WHERE business_id = b.id AND status = 'approuve'), 0)
      - COALESCE((SELECT SUM(amount_cents) FROM supplier_payments WHERE business_id = b.id), 0)
      - COALESCE((SELECT SUM(paid_amount)  FROM investor_payouts  WHERE business_id = b.id AND status = 'paye'), 0)
      AS cash_balance
  ) calc ON true
  WHERE calc.cash_balance < -10000000; -- More than 100 000 GNF negative (×100 cents)

  -- ── Check 71: Stock losses with zero cost (invisible in profit) ───────────
  INSERT INTO reconciliation_findings
    (run_id, check_id, domain, check_name, severity,
     business_id, entity_type, entity_id, detail, affected_count)
  SELECT
    p_run_id, 71, 'Affichage', 'Perte de stock avec coût nul', 'warning',
    sm.business_id, 'stock_move', sm.id,
    format('Perte de %s unité(s) de "%s" avec coût = 0 — non déductible du bénéfice, perte réelle sous-estimée',
      sm.qty, p.name),
    1
  FROM stock_moves sm
  JOIN products p ON p.id = sm.product_id
  WHERE sm.type = 'perte'
    AND sm.created_at >= now() - interval '90 days'
    AND COALESCE(p.cost_price, 0) = 0
    AND NOT COALESCE(p.is_system, false);

  -- ── Check 72: Manual transport_achat without PO link ─────────────────────
  INSERT INTO reconciliation_findings
    (run_id, check_id, domain, check_name, severity,
     business_id, entity_type, entity_id, detail, affected_count)
  SELECT
    p_run_id, 72, 'Affichage', 'Transport achat non lié à une commande', 'warning',
    e.business_id, 'expense', e.id,
    format('Dépense transport "%s" (%s centimes) sans commande fournisseur — possible doublon avec le coût de revient AVCO',
      e.description, e.amount),
    1
  FROM expenses_visible e
  WHERE e.category = 'transport_achat'
    AND e.purchase_order_id IS NULL
    AND e.status = 'approuve'
    AND e.date >= CURRENT_DATE - 90;

  -- ── Check 73: Investor balance negative ──────────────────────────────────
  INSERT INTO reconciliation_findings
    (run_id, check_id, domain, check_name, severity,
     business_id, detail, affected_count)
  SELECT
    p_run_id, 73, 'Affichage', 'Solde investisseur négatif', 'critical',
    ib.business_id,
    format('Boutique %s: solde investisseur %s négatif (%s centimes) — retraits confirmés > bénéfices accumulés',
      ib.business_id, ib.investor_id, ib.balance),
    1
  FROM investor_balance ib
  WHERE ib.balance < 0;

  -- ── Check 74: Revenue aggregate vs line-items aggregate ───────────────────
  INSERT INTO reconciliation_findings
    (run_id, check_id, domain, check_name, severity,
     business_id, detail, affected_count)
  WITH order_totals AS (
    SELECT so.business_id, so.id,
      SUM(so.total_amount - COALESCE(so.discount_amount, 0)) AS order_total
    FROM sale_orders so
    WHERE so.status IN ('paye', 'credit')
      AND so.sale_date >= CURRENT_DATE - 30
    GROUP BY so.business_id, so.id
  ),
  line_totals AS (
    SELECT so.business_id, so.id,
      SUM(sl.unit_price * sl.qty) AS lines_total
    FROM sale_orders so
    JOIN so_lines sl ON sl.order_id = so.id
    LEFT JOIN products p ON p.id = sl.product_id
    WHERE so.status IN ('paye', 'credit')
      AND so.sale_date >= CURRENT_DATE - 30
      AND NOT COALESCE(p.is_system, false)
    GROUP BY so.business_id, so.id
  ),
  agg AS (
    SELECT
      ot.business_id,
      SUM(ot.order_total) AS order_total,
      SUM(COALESCE(lt.lines_total, 0)) AS lines_total
    FROM order_totals ot
    LEFT JOIN line_totals lt ON lt.id = ot.id
    GROUP BY ot.business_id
    HAVING ABS(SUM(ot.order_total) - SUM(COALESCE(lt.lines_total, 0))) > 10000 -- 100 GNF tolerance
  )
  SELECT
    p_run_id, 74, 'Affichage', 'Écart revenu commandes vs lignes (30 jours)', 'warning',
    agg.business_id,
    format('Boutique %s: total commandes (%s GNF×100) ≠ total lignes (%s GNF×100) — écart %s centimes',
      agg.business_id, agg.order_total, agg.lines_total, ABS(agg.order_total - agg.lines_total)),
    1
  FROM agg;

  -- ── Check 75: Credit negative per order ──────────────────────────────────
  INSERT INTO reconciliation_findings
    (run_id, check_id, domain, check_name, severity,
     business_id, entity_type, entity_id, detail, affected_count)
  WITH paid_per_order AS (
    SELECT order_id, SUM(amount) AS total_paid
    FROM payments
    GROUP BY order_id
  )
  SELECT
    p_run_id, 75, 'Affichage', 'Crédit négatif affiché', 'critical',
    so.business_id, 'sale_order', so.id,
    format('Vente %s: collecté (%s) > montant dû (%s) — crédit négatif de %s centimes affiché dans les rapports',
      so.id,
      COALESCE(ppo.total_paid, 0),
      so.total_amount - COALESCE(so.discount_amount, 0),
      COALESCE(ppo.total_paid, 0) - (so.total_amount - COALESCE(so.discount_amount, 0))),
    1
  FROM sale_orders so
  LEFT JOIN paid_per_order ppo ON ppo.order_id = so.id
  WHERE so.status = 'credit'
    AND COALESCE(ppo.total_paid, 0) > (so.total_amount - COALESCE(so.discount_amount, 0)) + 100;

  -- ── Check 76: Product with negative cost_price ───────────────────────────
  INSERT INTO reconciliation_findings
    (run_id, check_id, domain, check_name, severity,
     business_id, entity_type, entity_id, detail, affected_count)
  SELECT
    p_run_id, 76, 'Affichage', 'Coût produit négatif', 'critical',
    p.business_id, 'product', p.id,
    format('Produit "%s" a un coût négatif (%s centimes) — COGS et valeur stock faussés dans les rapports',
      p.name, p.cost_price),
    1
  FROM products p
  WHERE p.cost_price < 0
    AND NOT p.archived
    AND NOT COALESCE(p.is_system, false);

  -- ── Check 77: Contributor's net capital position negative ────────────────
  INSERT INTO reconciliation_findings
    (run_id, check_id, domain, check_name, severity,
     business_id, detail, affected_count)
  SELECT
    p_run_id, 77, 'Affichage', 'Apport net négatif pour un contributeur', 'critical',
    agg.business_id,
    format('Contributeur "%s": apport net = %s centimes (retraits > apports enregistrés pour cette personne)',
      COALESCE(agg.source_name, agg.injected_by_id::text), agg.net_amount),
    1
  FROM (
    SELECT business_id, injected_by_id, source_name, SUM(amount) AS net_amount
    FROM capital_injections
    WHERE injected_by_id IS NOT NULL OR source_name IS NOT NULL
    GROUP BY business_id, injected_by_id, source_name
    HAVING SUM(amount) < 0
  ) agg;

  -- ── Check 78: Capital injection edited or withdrawn recently ─────────────
  INSERT INTO reconciliation_findings
    (run_id, check_id, domain, check_name, severity,
     business_id, entity_type, entity_id, detail, affected_count)
  SELECT
    p_run_id, 78, 'Affichage',
    CASE WHEN ci.amount < 0 THEN 'Retrait de capital enregistré' ELSE 'Apport corrigé manuellement' END,
    'warning',
    ci.business_id, 'capital_injection', ci.id,
    CASE WHEN ci.amount < 0
      THEN format('Retrait de %s centimes enregistré le %s', ABS(ci.amount), ci.injected_at)
      ELSE format('Apport de %s centimes modifié le %s', ci.amount, ci.edited_at::date)
    END,
    1
  FROM capital_injections ci
  WHERE (ci.amount < 0 AND ci.injected_at >= CURRENT_DATE - 90)
     OR (ci.edited_at IS NOT NULL AND ci.edited_at >= now() - interval '90 days');

  -- ── Check 79: Sale edited recently (visibility only) ─────────────────────
  -- edit_sale() (migration_v159.sql) is admin/manager only. Not an
  -- accusation — just a nightly list of every correction, same posture
  -- as check 78 for capital-injection edits.
  INSERT INTO reconciliation_findings
    (run_id, check_id, domain, check_name, severity,
     business_id, entity_type, entity_id, detail, affected_count)
  SELECT
    p_run_id, 79, 'Affichage', 'Vente modifiée', 'warning',
    so.business_id, 'sale_order', so.id,
    format('Vente %s modifiée %s fois — dernière modification le %s par %s',
      so.id, so.edit_count, so.last_edited_at::date, COALESCE(pr.name, so.last_edited_by::text)),
    1
  FROM sale_orders so
  LEFT JOIN profiles pr ON pr.id = so.last_edited_by
  WHERE so.edit_count > 0
    AND so.last_edited_at >= now() - interval '90 days';

  -- ── Check 80: Sale edited in the merchant's favor (the real fraud signal) ─
  -- Fires only when an edit moved money the merchant's way: total went
  -- down, discount went up, or amount paid went down. A genuine typo fix
  -- is just as likely to go up as down — a one-directional pattern is
  -- the actual tell, not the edit itself.
  INSERT INTO reconciliation_findings
    (run_id, check_id, domain, check_name, severity,
     business_id, entity_type, entity_id, detail, affected_count)
  SELECT
    p_run_id, 80, 'Affichage', 'Vente modifiée à la baisse', 'critical',
    diff.business_id, 'sale_order', diff.order_id,
    format('Vente %s modifiée par %s le %s: total %s→%s, remise %s→%s, payé %s→%s',
      diff.order_id, COALESCE(pr.name, diff.edited_by::text), diff.edited_at::date,
      diff.old_total, diff.new_total, diff.old_discount, diff.new_discount, diff.old_paid, diff.new_paid),
    1
  FROM (
    SELECT
      se.order_id, se.edited_by, se.edited_at, so.business_id,
      (se.before->>'total_amount')::bigint    AS old_total,
      (se.after->>'total_amount')::bigint     AS new_total,
      (se.before->>'discount_amount')::bigint AS old_discount,
      (se.after->>'discount_amount')::bigint  AS new_discount,
      (SELECT COALESCE(SUM((p->>'amount')::bigint), 0) FROM jsonb_array_elements(se.before->'payments') p) AS old_paid,
      (SELECT COALESCE(SUM((p->>'amount')::bigint), 0) FROM jsonb_array_elements(se.after->'payments') p)  AS new_paid
    FROM sale_order_edits se
    JOIN sale_orders so ON so.id = se.order_id
    WHERE se.edited_at >= now() - interval '90 days'
  ) diff
  LEFT JOIN profiles pr ON pr.id = diff.edited_by
  WHERE diff.new_total < diff.old_total
     OR diff.new_discount > diff.old_discount
     OR diff.new_paid < diff.old_paid;

END;
$function$;

-- run_reconciliation: its READS of expenses go through expenses_visible; INSERT/UPDATE targets are unchanged (6 read(s))
CREATE OR REPLACE FUNCTION public.run_reconciliation()
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_run_id UUID;
  v_biz_count INTEGER;
BEGIN
  INSERT INTO reconciliation_runs DEFAULT VALUES RETURNING id INTO v_run_id;
  SELECT COUNT(*) INTO v_biz_count FROM businesses;

  -- ============================================================
  -- DOMAIN 1 — STOCK  (checks 1–8)
  -- ============================================================

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,1,'Stock','Sortie stock manquante pour vente confirmée',
    'critical', so.business_id,'sale_order',so.id,
    'Vente #'||LEFT(so.id::TEXT,8)||' ('||so.status||'): '||COUNT(sl.id)||
    ' ligne(s) sans mouvement de stock "sortie" correspondant',
    COUNT(sl.id)::INT
  FROM sale_orders so
  JOIN so_lines sl ON sl.order_id = so.id
  JOIN products p ON p.id = sl.product_id
  WHERE so.status IN ('paye','credit')
    AND p.is_system = false
    AND NOT EXISTS (
      SELECT 1 FROM stock_moves sm
      WHERE sm.ref_id = so.id AND sm.type = 'sortie' AND sm.product_id = sl.product_id
    )
  GROUP BY so.business_id, so.id, so.status
  HAVING COUNT(sl.id) > 0;

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,2,'Stock','Quantité sortie ≠ quantité vendue',
    'critical', so.business_id,'sale_order',so.id,
    'Vente #'||LEFT(so.id::TEXT,8)||' produit "'||sl_agg.product_name||
    '": so_lines.qty(total)='||sl_agg.total||' mais stock_moves.qty='||COALESCE(sm_agg.total,0),
    1
  FROM sale_orders so
  JOIN (
    SELECT sl.order_id, sl.product_id,
      SUM(sl.qty) AS total,
      MAX(COALESCE(sl.product_name, sl.product_id::TEXT)) AS product_name
    FROM so_lines sl
    JOIN products p ON p.id = sl.product_id
    WHERE p.is_system = false
    GROUP BY sl.order_id, sl.product_id
  ) sl_agg ON sl_agg.order_id = so.id
  LEFT JOIN (
    SELECT ref_id, product_id, SUM(qty) AS total
    FROM stock_moves WHERE type = 'sortie'
    GROUP BY ref_id, product_id
  ) sm_agg ON sm_agg.ref_id = so.id AND sm_agg.product_id = sl_agg.product_id
  WHERE so.status IN ('paye','credit')
    AND sl_agg.total != COALESCE(sm_agg.total, 0);

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,3,'Stock','Restauration stock manquante pour vente annulée',
    'critical', so.business_id,'sale_order',so.id,
    'Vente annulée #'||LEFT(so.id::TEXT,8)||': '||COUNT(sl.id)||
    ' ligne(s) sans mouvement de restauration — stock définitivement perdu',
    COUNT(sl.id)::INT
  FROM sale_orders so
  JOIN so_lines sl ON sl.order_id = so.id
  WHERE so.status = 'annule'
    AND sl.cost_price_at_sale IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM stock_moves sm
      WHERE sm.ref_id = so.id
        AND sm.type = 'entree'
        AND sm.product_id = sl.product_id
    )
  GROUP BY so.business_id, so.id
  HAVING COUNT(sl.id) > 0;

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,4,'Stock','Quantité restaurée ≠ quantité vendue initialement',
    'critical', so.business_id,'sale_order',so.id,
    'Vente annulée #'||LEFT(so.id::TEXT,8)||' produit "'||COALESCE(sl.product_name,sl.product_id::TEXT)||
    '": vendu='||sl.qty||' restauré='||COALESCE(sm_agg.total,0)||
    ' (écart='||(sl.qty - COALESCE(sm_agg.total,0))||')',
    1
  FROM sale_orders so
  JOIN so_lines sl ON sl.order_id = so.id
  JOIN (
    SELECT ref_id, product_id, SUM(qty) AS total
    FROM stock_moves WHERE type = 'entree'
    GROUP BY ref_id, product_id
  ) sm_agg ON sm_agg.ref_id = so.id AND sm_agg.product_id = sl.product_id
  WHERE so.status = 'annule'
    AND sl.cost_price_at_sale IS NOT NULL
    AND sl.qty != sm_agg.total;

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,5,'Stock','Stock produit négatif',
    'critical', p.business_id,'product',p.id,
    'Produit "'||p.name||'": stock_qty='||p.stock_qty||' (négatif — vente sans stock disponible)',
    1
  FROM products p WHERE p.stock_qty < 0;

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,6,'Stock','Stock variante négatif',
    'critical', p.business_id,'product_variant',pv.id,
    'Variante "'||pv.name||'" (produit "'||p.name||'"): stock_qty='||pv.stock_qty||' (négatif)',
    1
  FROM product_variants pv
  JOIN products p ON p.id = pv.product_id
  WHERE pv.stock_qty < 0;

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,7,'Stock','Stock parent ≠ somme des variantes',
    'critical', p.business_id,'product',p.id,
    'Produit "'||p.name||'": stock_qty='||p.stock_qty||
    ' mais ∑ variantes='||var_sum.total||
    ' (écart='||(p.stock_qty - var_sum.total)||')',
    1
  FROM products p
  JOIN (
    SELECT product_id, SUM(stock_qty) AS total
    FROM product_variants GROUP BY product_id
  ) var_sum ON var_sum.product_id = p.id
  WHERE p.stock_qty != var_sum.total;

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,8,'Stock','Réception commande sans mouvement de stock entrant',
    'warning', po.business_id,'purchase_order',po.id,
    'Commande #'||LEFT(po.id::TEXT,8)||': '||COUNT(pol.id)||
    ' ligne(s) reçue(s) sans "entree" stock_move correspondant',
    COUNT(pol.id)::INT
  FROM purchase_orders po
  JOIN po_lines pol ON pol.po_id = po.id
  WHERE po.status IN ('recu','recu_partiel')
    AND pol.qty_received > 0
    AND NOT EXISTS (
      SELECT 1 FROM stock_moves sm
      WHERE sm.ref_id = po.id AND sm.type = 'entree' AND sm.product_id = pol.product_id
    )
  GROUP BY po.business_id, po.id
  HAVING COUNT(pol.id) > 0;

  -- ============================================================
  -- DOMAIN 2 — SALE ORDER INTEGRITY  (checks 9–15)
  -- ============================================================

  -- 9. Sale total ≠ sum of line items
  --    [v107] unit_price is now always the real price charged —
  --    no COALESCE(unit_price_paid, unit_price) needed any more.
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,9,'Ventes','Total vente ≠ somme des lignes',
    'critical', so.business_id,'sale_order',so.id,
    'Vente #'||LEFT(so.id::TEXT,8)||': total_amount='||so.total_amount||
    ' mais ∑(qty×prix payé)='||COALESCE(ls.total,0)||
    ' (écart='||(so.total_amount - COALESCE(ls.total,0))||')',
    1
  FROM sale_orders so
  LEFT JOIN (
    SELECT order_id, SUM(qty * unit_price) AS total
    FROM so_lines GROUP BY order_id
  ) ls ON ls.order_id = so.id
  WHERE so.status IN ('paye','credit','annule')
    AND so.total_amount != COALESCE(ls.total, 0);

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,10,'Ventes','Vente confirmée sans aucune ligne',
    'critical', so.business_id,'sale_order',so.id,
    'Vente #'||LEFT(so.id::TEXT,8)||' (statut: '||so.status||
    '): aucune so_line — stock jamais touché, CA jamais enregistré',
    1
  FROM sale_orders so
  WHERE so.status IN ('paye','credit','annule')
    AND NOT EXISTS (SELECT 1 FROM so_lines sl WHERE sl.order_id = so.id);

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,11,'Ventes','Remise ≥ montant total',
    'critical', so.business_id,'sale_order',so.id,
    'Vente #'||LEFT(so.id::TEXT,8)||': discount_amount='||so.discount_amount||
    ' >= total_amount='||so.total_amount||' (net payable ≤ 0)',
    1
  FROM sale_orders so
  WHERE so.discount_amount >= so.total_amount
    AND so.discount_amount > 0
    AND so.status NOT IN ('brouillon');

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,12,'Ventes','Lignes de vente orphelines',
    'critical', NULL,'so_line',sl.id,
    'so_line #'||LEFT(sl.id::TEXT,8)||': order_id='||sl.order_id||' introuvable',
    1
  FROM so_lines sl
  WHERE NOT EXISTS (SELECT 1 FROM sale_orders so WHERE so.id = sl.order_id);

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,13,'Ventes','Ligne de vente avec produit supprimé',
    'critical', so.business_id,'so_line',sl.id,
    'Ligne #'||LEFT(sl.id::TEXT,8)||' (vente '||LEFT(so.id::TEXT,8)||
    '): product_id='||sl.product_id||' introuvable',
    1
  FROM so_lines sl
  JOIN sale_orders so ON so.id = sl.order_id
  WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.id = sl.product_id);

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,14,'Ventes','Instantané nom produit manquant',
    'warning', so.business_id,'sale_order',so.id,
    'Vente #'||LEFT(so.id::TEXT,8)||': '||COUNT(sl.id)||
    ' ligne(s) sans product_name — historique ventes incomplet',
    COUNT(sl.id)::INT
  FROM sale_orders so
  JOIN so_lines sl ON sl.order_id = so.id
  WHERE sl.product_name IS NULL
    AND so.status IN ('paye','credit')
    AND so.created_at > '2024-01-01'
  GROUP BY so.business_id, so.id
  HAVING COUNT(sl.id) > 0;

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,15,'Ventes','Clé idempotence dupliquée',
    'critical', so.business_id,'sale_order',MIN(so.id::text)::uuid,
    'Clé '||so.idempotency_key||': '||COUNT(so.id)||
    ' ventes avec la même clé (vente enregistrée plusieurs fois)',
    COUNT(so.id)::INT
  FROM sale_orders so
  WHERE so.idempotency_key IS NOT NULL
    AND so.status != 'annule'
  GROUP BY so.business_id, so.idempotency_key
  HAVING COUNT(so.id) > 1;

  -- ============================================================
  -- DOMAIN 3 — PAYMENTS  (checks 16–22, 69)
  -- ============================================================

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,16,'Paiements','Vente "paye" non entièrement couverte',
    'critical', so.business_id,'sale_order',so.id,
    'Vente #'||LEFT(so.id::TEXT,8)||': net dû='||
    (so.total_amount - so.discount_amount)||
    ' paiements reçus='||COALESCE(ps.total,0)||
    ' (écart='||((so.total_amount - so.discount_amount) - COALESCE(ps.total,0))||')',
    1
  FROM sale_orders so
  LEFT JOIN (
    SELECT order_id, SUM(amount) AS total FROM payments GROUP BY order_id
  ) ps ON ps.order_id = so.id
  WHERE so.status = 'paye'
    AND COALESCE(ps.total, 0) < (so.total_amount - so.discount_amount);

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,17,'Paiements','Crédit soldé mais non clôturé',
    'warning', so.business_id,'sale_order',so.id,
    'Vente crédit #'||LEFT(so.id::TEXT,8)||': net dû='||
    (so.total_amount - so.discount_amount)||
    ' paiements reçus='||ps.total||
    ' — devrait être marquée "paye"',
    1
  FROM sale_orders so
  JOIN (
    SELECT order_id, SUM(amount) AS total FROM payments GROUP BY order_id
  ) ps ON ps.order_id = so.id
  WHERE so.status = 'credit'
    AND ps.total >= (so.total_amount - so.discount_amount);

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,18,'Paiements','Paiement sur vente annulée',
    'critical', so.business_id,'sale_order',so.id,
    'Vente annulée #'||LEFT(so.id::TEXT,8)||': '||COUNT(p.id)||
    ' paiement(s) pour '||SUM(p.amount)||' — argent comptabilisé pour transaction inexistante',
    COUNT(p.id)::INT
  FROM sale_orders so
  JOIN payments p ON p.order_id = so.id
  WHERE so.status = 'annule'
  GROUP BY so.business_id, so.id;

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,19,'Paiements','Paiement sur brouillon non confirmé',
    'critical', so.business_id,'sale_order',so.id,
    'Brouillon #'||LEFT(so.id::TEXT,8)||': '||COUNT(p.id)||
    ' paiement(s) sur vente jamais confirmée',
    COUNT(p.id)::INT
  FROM sale_orders so
  JOIN payments p ON p.order_id = so.id
  WHERE so.status = 'brouillon'
  GROUP BY so.business_id, so.id;

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,20,'Paiements','Montant de paiement nul ou négatif',
    'critical', so.business_id,'payment',p.id,
    'Paiement #'||LEFT(p.id::TEXT,8)||
    ' (vente '||LEFT(p.order_id::TEXT,8)||'): amount='||p.amount||' (invalide)',
    1
  FROM payments p
  JOIN sale_orders so ON so.id = p.order_id
  WHERE p.amount <= 0;

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,21,'Paiements','Paiement sans vente associée',
    'critical', NULL,'payment',p.id,
    'Paiement #'||LEFT(p.id::TEXT,8)||': order_id='||p.order_id||' introuvable',
    1
  FROM payments p
  WHERE NOT EXISTS (SELECT 1 FROM sale_orders so WHERE so.id = p.order_id);

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,22,'Paiements','Surpaiement sur crédit',
    'critical', so.business_id,'sale_order',so.id,
    'Vente crédit #'||LEFT(so.id::TEXT,8)||': net dû='||
    (so.total_amount - so.discount_amount)||
    ' paiements='||ps.total||
    ' surplus='||(ps.total - (so.total_amount - so.discount_amount)),
    1
  FROM sale_orders so
  JOIN (
    SELECT order_id, SUM(amount) AS total FROM payments GROUP BY order_id
  ) ps ON ps.order_id = so.id
  WHERE so.status = 'credit'
    AND ps.total > (so.total_amount - so.discount_amount);

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,69,'Paiements','Vente "paye" surpayée',
    'critical', so.business_id,'sale_order',so.id,
    'Vente #'||LEFT(so.id::TEXT,8)||': net dû='||
    (so.total_amount - so.discount_amount)||
    ' paiements reçus='||ps.total||
    ' (surplus='||(ps.total - (so.total_amount - so.discount_amount))||')',
    1
  FROM sale_orders so
  JOIN (
    SELECT order_id, SUM(amount) AS total FROM payments GROUP BY order_id
  ) ps ON ps.order_id = so.id
  WHERE so.status = 'paye'
    AND ps.total > (so.total_amount - so.discount_amount);

  -- ============================================================
  -- DOMAIN 4 — COGS ET COÛT DE REVIENT  (checks 23–26)
  -- ============================================================

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,23,'COGS','Coût de revient non capturé',
    'critical', so.business_id,'sale_order',so.id,
    'Vente #'||LEFT(so.id::TEXT,8)||': '||COUNT(sl.id)||
    ' ligne(s) sans cost_price_at_sale — profit sur ces ventes surestimé à 100%',
    COUNT(sl.id)::INT
  FROM sale_orders so
  JOIN so_lines sl ON sl.order_id = so.id
  JOIN products p ON p.id = sl.product_id
  WHERE so.status IN ('paye','credit')
    AND sl.cost_price_at_sale IS NULL
    AND p.cost_price > 0
  GROUP BY so.business_id, so.id
  HAVING COUNT(sl.id) > 0;

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,24,'COGS','Coût de revient négatif',
    'critical', so.business_id,'so_line',sl.id,
    'Ligne #'||LEFT(sl.id::TEXT,8)||' (vente '||LEFT(so.id::TEXT,8)||
    '): cost_price_at_sale='||sl.cost_price_at_sale||' (valeur négative impossible)',
    1
  FROM so_lines sl
  JOIN sale_orders so ON so.id = sl.order_id
  WHERE sl.cost_price_at_sale < 0;

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,25,'COGS','Lignes de vente à coût zéro',
    'warning', so.business_id,'sale_order',so.id,
    'Vente #'||LEFT(so.id::TEXT,8)||': '||COUNT(sl.id)||
    ' ligne(s) avec cost_price_at_sale=0 — vérifier si intentionnel',
    COUNT(sl.id)::INT
  FROM sale_orders so
  JOIN so_lines sl ON sl.order_id = so.id
  WHERE so.status IN ('paye','credit')
    AND sl.cost_price_at_sale = 0
  GROUP BY so.business_id, so.id
  HAVING COUNT(sl.id) > 0;

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,26,'COGS','Vente à perte',
    'warning', so.business_id,'sale_order',so.id,
    'Vente #'||LEFT(so.id::TEXT,8)||': COGS='||cogs.total||
    ' > net='||(so.total_amount - so.discount_amount)||
    ' (perte='||(cogs.total - (so.total_amount - so.discount_amount))||')',
    1
  FROM sale_orders so
  JOIN (
    SELECT order_id, SUM(qty * cost_price_at_sale) AS total
    FROM so_lines WHERE cost_price_at_sale IS NOT NULL
    GROUP BY order_id
  ) cogs ON cogs.order_id = so.id
  WHERE so.status IN ('paye','credit')
    AND cogs.total > (so.total_amount - so.discount_amount);

  -- ============================================================
  -- DOMAIN 5 — DÉPENSES  (checks 27–30)
  -- ============================================================

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,27,'Dépenses','Montant de dépense nul ou négatif',
    'critical', e.business_id,'expense',e.id,
    'Dépense #'||LEFT(e.id::TEXT,8)||': amount='||e.amount||' (invalide)',
    1
  FROM expenses_visible e WHERE e.amount <= 0;

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,28,'Dépenses','Statut dépense invalide',
    'critical', e.business_id,'expense',e.id,
    'Dépense #'||LEFT(e.id::TEXT,8)||': statut="'||e.status||'" non reconnu',
    1
  FROM expenses_visible e
  WHERE e.status NOT IN ('en_attente','approuve','rejete');

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,29,'Dépenses','Dépense sans boutique',
    'critical', e.business_id,'expense',e.id,
    'Dépense #'||LEFT(e.id::TEXT,8)||': business_id='||e.business_id||' introuvable',
    1
  FROM expenses_visible e
  WHERE NOT EXISTS (SELECT 1 FROM businesses b WHERE b.id = e.business_id);

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,30,'Dépenses','Boutique avec ventes mais aucune dépense ce mois',
    'warning', b.id,'business',b.id,
    'Boutique "'||b.name||'": '||sc.cnt||
    ' vente(s) ce mois, 0 dépense approuvée — sous-déclaration probable',
    sc.cnt
  FROM businesses b
  JOIN (
    SELECT business_id, COUNT(*) AS cnt
    FROM sale_orders
    WHERE status IN ('paye','credit')
      AND created_at >= DATE_TRUNC('month', CURRENT_DATE)
    GROUP BY business_id HAVING COUNT(*) >= 10
  ) sc ON sc.business_id = b.id
  WHERE NOT EXISTS (
    SELECT 1 FROM expenses_visible e
    WHERE e.business_id = b.id
      AND e.status = 'approuve'
      AND e.created_at >= DATE_TRUNC('month', CURRENT_DATE)
  );

  -- ============================================================
  -- DOMAIN 6 — CRÉDIT / COMPTES CLIENTS  (checks 31–34)
  -- ============================================================

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,31,'Crédit','Solde crédit négatif — surpaiement non traité',
    'critical', so.business_id,'sale_order',so.id,
    'Vente crédit #'||LEFT(so.id::TEXT,8)||
    ': solde=('||(so.total_amount - so.discount_amount)||
    ' - '||COALESCE(ps.total,0)||')='||
    ((so.total_amount - so.discount_amount) - COALESCE(ps.total,0))||' (négatif)',
    1
  FROM sale_orders so
  LEFT JOIN (
    SELECT order_id, SUM(amount) AS total FROM payments GROUP BY order_id
  ) ps ON ps.order_id = so.id
  WHERE so.status = 'credit'
    AND (so.total_amount - so.discount_amount) - COALESCE(ps.total,0) < 0;

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,32,'Crédit','Crédit en retard de paiement',
    'warning', so.business_id,'sale_order',so.id,
    'Vente crédit #'||LEFT(so.id::TEXT,8)||
    ': échéance='||so.due_date||
    ' client="'||COALESCE(c.name, so.customer_name, 'inconnu')||'"'||
    ' solde='||((so.total_amount - so.discount_amount) - COALESCE(ps.total,0)),
    1
  FROM sale_orders so
  LEFT JOIN clients c ON c.id = so.client_id
  LEFT JOIN (
    SELECT order_id, SUM(amount) AS total FROM payments GROUP BY order_id
  ) ps ON ps.order_id = so.id
  WHERE so.status = 'credit'
    AND so.due_date IS NOT NULL
    AND so.due_date < CURRENT_DATE
    AND (so.total_amount - so.discount_amount) - COALESCE(ps.total,0) > 0;

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,33,'Crédit','Vente avec client inexistant',
    'warning', so.business_id,'sale_order',so.id,
    'Vente #'||LEFT(so.id::TEXT,8)||': client_id='||so.client_id||' introuvable',
    1
  FROM sale_orders so
  WHERE so.client_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM clients c WHERE c.id = so.client_id);

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,34,'Crédit','Solde crédit global incohérent',
    'critical', b.id,'business',b.id,
    'Boutique "'||b.name||'": (CA - encaissé)='||
    (COALESCE(rev.total,0) - COALESCE(cash.total,0))||
    ' ≠ crédit en attente='||COALESCE(credit_bal.total,0)||
    ' (écart='||ABS((COALESCE(rev.total,0) - COALESCE(cash.total,0)) - COALESCE(credit_bal.total,0))||')',
    1
  FROM businesses b
  LEFT JOIN (
    SELECT business_id, SUM(total_amount - discount_amount) AS total
    FROM sale_orders WHERE status IN ('paye','credit') GROUP BY business_id
  ) rev ON rev.business_id = b.id
  LEFT JOIN (
    SELECT so.business_id, SUM(p.amount) AS total
    FROM payments p JOIN sale_orders so ON so.id = p.order_id
    GROUP BY so.business_id
  ) cash ON cash.business_id = b.id
  LEFT JOIN (
    SELECT so.business_id,
      SUM((so.total_amount - so.discount_amount) - COALESCE(ps.total,0)) AS total
    FROM sale_orders so
    LEFT JOIN (
      SELECT order_id, SUM(amount) AS total FROM payments GROUP BY order_id
    ) ps ON ps.order_id = so.id
    WHERE so.status = 'credit'
    GROUP BY so.business_id
  ) credit_bal ON credit_bal.business_id = b.id
  WHERE ABS(
    (COALESCE(rev.total,0) - COALESCE(cash.total,0)) - COALESCE(credit_bal.total,0)
  ) > 0;

  -- ============================================================
  -- DOMAIN 7 — DETTES FOURNISSEURS  (checks 35–36)
  -- ============================================================

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,35,'Fournisseurs','Surpaiement fournisseur',
    'warning', sd.business_id,'supplier_debt',sd.id,
    'Dette fournisseur #'||LEFT(sd.id::TEXT,8)||
    ': montant='||sd.amount||' amount_paid='||sd.amount_paid||
    ' (surplus='||(sd.amount_paid - sd.amount)||')',
    1
  FROM supplier_debts sd WHERE sd.amount_paid > sd.amount;

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,36,'Fournisseurs','Dette sans fournisseur valide',
    'critical', sd.business_id,'supplier_debt',sd.id,
    'Dette #'||LEFT(sd.id::TEXT,8)||': supplier_id='||sd.supplier_id||' introuvable',
    1
  FROM supplier_debts sd
  WHERE NOT EXISTS (SELECT 1 FROM suppliers s WHERE s.id = sd.supplier_id);

  -- ============================================================
  -- DOMAIN 8 — COMMANDES FOURNISSEURS  (checks 37–40)
  -- ============================================================

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,37,'Commandes','Quantité reçue > quantité commandée',
    'critical', po.business_id,'purchase_order',po.id,
    'Commande #'||LEFT(po.id::TEXT,8)||' produit "'||COALESCE(p.name,pol.product_id::TEXT)||
    '": reçu='||pol.qty_received||' > commandé='||pol.qty_ordered,
    1
  FROM po_lines pol
  JOIN purchase_orders po ON po.id = pol.po_id
  LEFT JOIN products p ON p.id = pol.product_id
  WHERE pol.qty_received > pol.qty_ordered;

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,38,'Commandes','Statut commande incohérent avec réception',
    'warning', po.business_id,'purchase_order',po.id,
    'Commande #'||LEFT(po.id::TEXT,8)||': statut="'||po.status||'" mais '||
    CASE
      WHEN tot.rcvd = tot.ord THEN 'tout reçu → devrait être "recu"'
      WHEN tot.rcvd > 0 AND tot.rcvd < tot.ord THEN 'partiel → devrait être "recu_partiel"'
      ELSE 'rien reçu → devrait être "brouillon" ou "envoye"'
    END,
    1
  FROM purchase_orders po
  JOIN (
    SELECT po_id, SUM(qty_ordered) AS ord, SUM(qty_received) AS rcvd
    FROM po_lines GROUP BY po_id
  ) tot ON tot.po_id = po.id
  WHERE po.status NOT IN ('annule') AND (
    (tot.rcvd = tot.ord AND po.status != 'recu')
    OR (tot.rcvd > 0 AND tot.rcvd < tot.ord AND po.status != 'recu_partiel')
    OR (tot.rcvd = 0 AND po.status IN ('recu','recu_partiel'))
  );

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,39,'Commandes','Ligne de commande avec produit inexistant',
    'critical', po.business_id,'purchase_order',po.id,
    'Commande #'||LEFT(po.id::TEXT,8)||': product_id='||pol.product_id||' introuvable',
    1
  FROM po_lines pol
  JOIN purchase_orders po ON po.id = pol.po_id
  WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.id = pol.product_id);

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,40,'Commandes','Quantité reçue négative',
    'critical', po.business_id,'purchase_order',po.id,
    'Commande #'||LEFT(po.id::TEXT,8)||': qty_received='||pol.qty_received||' (négatif)',
    1
  FROM po_lines pol
  JOIN purchase_orders po ON po.id = pol.po_id
  WHERE pol.qty_received < 0;

  -- ============================================================
  -- DOMAIN 9 — INTÉGRITÉ PRODUITS  (checks 41–45)
  -- ============================================================

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,41,'Produits','Prix de vente nul ou négatif',
    'critical', p.business_id,'product',p.id,
    'Produit actif "'||p.name||'": sale_price='||p.sale_price||
    ' — toute vente enregistre un CA de 0',
    1
  FROM products p
  WHERE p.sale_price <= 0 AND p.archived = false AND p.is_system = false;

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,42,'Produits','Coût de revient > prix de vente',
    'warning', p.business_id,'product',p.id,
    'Produit "'||p.name||'": cost_price='||p.cost_price||
    ' > sale_price='||p.sale_price||' (vente à perte systématique)',
    1
  FROM products p
  WHERE p.cost_price > p.sale_price
    AND p.archived = false AND p.cost_price > 0;

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,43,'Produits','Prix gros ≥ prix unitaire',
    'warning', p.business_id,'product',p.id,
    'Produit "'||p.name||'": bulk_price='||p.bulk_price||
    ' >= sale_price='||p.sale_price||' (le gros devrait coûter moins cher)',
    1
  FROM products p
  WHERE p.bulk_price IS NOT NULL
    AND p.bulk_price >= p.sale_price
    AND p.archived = false;

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,44,'Produits','Produit archivé avec crédit non soldé',
    'warning', p.business_id,'product',p.id,
    'Produit archivé "'||p.name||'": '||COUNT(DISTINCT so.id)||
    ' vente(s) crédit encore ouvertes',
    COUNT(DISTINCT so.id)::INT
  FROM products p
  JOIN so_lines sl ON sl.product_id = p.id
  JOIN sale_orders so ON so.id = sl.order_id
  WHERE p.archived = true AND so.status = 'credit'
  GROUP BY p.business_id, p.id, p.name;

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,45,'Produits','Produit sans nom',
    'warning', p.business_id,'product',p.id,
    'Produit #'||LEFT(p.id::TEXT,8)||': name vide ou nul',
    1
  FROM products p
  WHERE (p.name IS NULL OR TRIM(p.name) = '') AND p.archived = false;

  -- ============================================================
  -- DOMAIN 10 — PRÉCISION MONÉTAIRE  (checks 46–48)
  -- ============================================================

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,46,'Montants','Prix de vente anormalement bas (×100 oublié ?)',
    'warning', p.business_id,'product',p.id,
    'Produit "'||p.name||'": sale_price='||p.sale_price||
    ' centimes ('||(p.sale_price/100.0)||' unité) — vérifier multiplication ×100',
    1
  FROM products p
  WHERE p.sale_price > 0 AND p.sale_price < 100
    AND p.archived = false AND p.is_system = false;

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,47,'Montants','Montant vente anormalement élevé',
    'warning', so.business_id,'sale_order',so.id,
    'Vente #'||LEFT(so.id::TEXT,8)||': total_amount='||so.total_amount||
    ' ('||(so.total_amount/100)||' unités) — possible erreur de saisie',
    1
  FROM sale_orders so
  WHERE so.total_amount > 1000000000000
    AND so.status IN ('paye','credit');

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,48,'Montants','Dépense anormalement élevée',
    'warning', e.business_id,'expense',e.id,
    'Dépense #'||LEFT(e.id::TEXT,8)||': amount='||e.amount||
    ' ('||(e.amount/100)||' unités) — possible erreur de saisie',
    1
  FROM expenses_visible e WHERE e.amount > 1000000000000;

  -- ============================================================
  -- DOMAIN 11 — MEMBRES ET RÔLES  (checks 49–52)
  -- ============================================================

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,49,'Membres','Boutique sans administrateur unique',
    'critical', b.id,'business',b.id,
    'Boutique "'||b.name||'": '||COALESCE(ac.cnt,0)||
    ' administrateur(s) (exactement 1 requis)',
    1
  FROM businesses b
  LEFT JOIN (
    SELECT business_id, COUNT(*) AS cnt FROM memberships
    WHERE role = 'administrateur' GROUP BY business_id
  ) ac ON ac.business_id = b.id
  WHERE COALESCE(ac.cnt,0) != 1;

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,50,'Membres','Plus d''un manager',
    'critical', m.business_id,'business',m.business_id,
    'Boutique '||LEFT(m.business_id::TEXT,8)||': '||COUNT(m.id)||' managers (max 1)',
    COUNT(m.id)::INT
  FROM memberships m
  WHERE m.role = 'manager'
  GROUP BY m.business_id HAVING COUNT(m.id) > 1;

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,51,'Membres','Rôle invalide',
    'critical', m.business_id,'membership',m.id,
    'Membership #'||LEFT(m.id::TEXT,8)||': rôle="'||m.role||'" non reconnu',
    1
  FROM memberships m
  WHERE m.role NOT IN ('administrateur','manager','vendeur','investisseur');

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,52,'Membres','Membre sans profil utilisateur',
    'critical', m.business_id,'membership',m.id,
    'Membership #'||LEFT(m.id::TEXT,8)||': user_id='||m.user_id||' sans profil',
    1
  FROM memberships m
  WHERE NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = m.user_id);

  -- ============================================================
  -- DOMAIN 12 — AGRÉGATS CROISÉS  (checks 53–57)
  -- ============================================================

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,53,'Agrégats','Paiements sans attribution boutique',
    'critical', NULL,'business',NULL,
    'SUM global payments='||direct_sum.t||
    ' ≠ SUM via sale_orders='||joined_sum.t||
    ' — '||(direct_sum.t - joined_sum.t)||' en paiements non attribuables',
    1
  FROM (SELECT COALESCE(SUM(amount),0) AS t FROM payments) direct_sum,
       (SELECT COALESCE(SUM(p.amount),0) AS t
        FROM payments p JOIN sale_orders so ON so.id = p.order_id) joined_sum
  WHERE direct_sum.t != joined_sum.t;

  -- [v179] Excludes is_system product lines (e.g. "Solde reporté", the
  -- carnet-debt placeholder product) the same way checks #1/#2 already do
  -- — a carnet-debt-only/heavy business has genuinely no cost to capture
  -- for those lines by design, not a real data gap. Previously joined
  -- so_lines straight to sale_orders with no products join at all, so
  -- this warning fired for every such business, every night, forever.
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,54,'Agrégats','Taux de couverture COGS insuffisant',
    'warning', so.business_id,'business',so.business_id,
    'Boutique '||LEFT(so.business_id::TEXT,8)||': seulement '||
    ROUND(100.0*SUM(CASE WHEN sl.cost_price_at_sale IS NOT NULL THEN 1 ELSE 0 END)/COUNT(sl.id),1)||
    '% des lignes de vente ont un coût capturé — profit global surestimé',
    SUM(CASE WHEN sl.cost_price_at_sale IS NULL THEN 1 ELSE 0 END)::INT
  FROM sale_orders so
  JOIN so_lines sl ON sl.order_id = so.id
  JOIN products p ON p.id = sl.product_id
  WHERE so.status IN ('paye','credit')
    AND so.created_at > '2024-01-01'
    AND p.is_system = false
  GROUP BY so.business_id
  HAVING 100.0*SUM(CASE WHEN sl.cost_price_at_sale IS NOT NULL THEN 1 ELSE 0 END)/COUNT(sl.id) < 90;

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,55,'Agrégats','Boutique inactive 30 jours',
    'warning', b.id,'business',b.id,
    'Boutique "'||b.name||'": dernière vente le '||
    COALESCE(ls.last_at::DATE::TEXT,'jamais')||
    ' ('||EXTRACT(DAY FROM now()-COALESCE(ls.last_at,b.created_at))::INT||' j)',
    1
  FROM businesses b
  LEFT JOIN (
    SELECT business_id, MAX(created_at) AS last_at
    FROM sale_orders WHERE status IN ('paye','credit')
    GROUP BY business_id
  ) ls ON ls.business_id = b.id
  WHERE (ls.last_at IS NULL OR ls.last_at < now() - INTERVAL '30 days')
    AND b.created_at < now() - INTERVAL '7 days';

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,56,'Agrégats','COGS > CA ce mois (perte brute)',
    'warning', so.business_id,'business',so.business_id,
    'Boutique '||LEFT(so.business_id::TEXT,8)||
    ': CA='||SUM(so.total_amount - so.discount_amount)||
    ' COGS='||SUM(cogs.line_cogs)||
    ' marge brute='||(SUM(so.total_amount-so.discount_amount)-SUM(cogs.line_cogs)),
    COUNT(so.id)::INT
  FROM sale_orders so
  JOIN (
    SELECT sl.order_id, SUM(sl.qty * COALESCE(sl.cost_price_at_sale,0)) AS line_cogs
    FROM so_lines sl GROUP BY sl.order_id
  ) cogs ON cogs.order_id = so.id
  WHERE so.status IN ('paye','credit')
    AND so.created_at >= DATE_TRUNC('month', CURRENT_DATE)
  GROUP BY so.business_id
  HAVING SUM(cogs.line_cogs) > SUM(so.total_amount - so.discount_amount);

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,57,'Agrégats','Ventes orphelines sans boutique',
    'critical', so.business_id,'sale_order',so.id,
    'Vente #'||LEFT(so.id::TEXT,8)||': business_id='||so.business_id||' introuvable',
    1
  FROM sale_orders so
  WHERE NOT EXISTS (SELECT 1 FROM businesses b WHERE b.id = so.business_id);

  -- ============================================================
  -- DOMAIN 13 — INTÉGRITÉ TEMPORELLE  (checks 58–61)
  -- ============================================================

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,58,'Temporel','Vente datée dans le futur',
    'critical', so.business_id,'sale_order',so.id,
    'Vente #'||LEFT(so.id::TEXT,8)||': created_at='||so.created_at||' (future)',
    1
  FROM sale_orders so
  WHERE so.created_at > now() + INTERVAL '5 minutes';

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,59,'Temporel','Paiement antérieur à la vente',
    'critical', so.business_id,'payment',p.id,
    'Paiement #'||LEFT(p.id::TEXT,8)||
    ': created_at='||p.created_at::DATE||
    ' avant vente #'||LEFT(so.id::TEXT,8)||' ('||so.created_at::DATE||')',
    1
  FROM payments p
  JOIN sale_orders so ON so.id = p.order_id
  WHERE p.created_at < so.created_at - INTERVAL '1 minute';

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,60,'Temporel','Échéance crédit antérieure à la vente',
    'warning', so.business_id,'sale_order',so.id,
    'Vente crédit #'||LEFT(so.id::TEXT,8)||
    ': due_date='||so.due_date||' avant sale_date='||so.sale_date,
    1
  FROM sale_orders so
  WHERE so.due_date IS NOT NULL
    AND so.sale_date IS NOT NULL
    AND so.due_date < so.sale_date
    AND so.status = 'credit';

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,61,'Temporel','Dépense datée dans le futur',
    'warning', e.business_id,'expense',e.id,
    'Dépense #'||LEFT(e.id::TEXT,8)||': created_at='||e.created_at||' (future)',
    1
  FROM expenses_visible e
  WHERE e.created_at > now() + INTERVAL '5 minutes';

  -- ============================================================
  -- DOMAIN 14 — INTÉGRITÉ RÉFÉRENTIELLE  (checks 62–68)
  -- ============================================================

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,62,'Intégrité','Mouvement de stock sans produit',
    'critical', sm.business_id,'stock_move',sm.id,
    'Mouvement #'||LEFT(sm.id::TEXT,8)||': product_id='||sm.product_id||' introuvable',
    1
  FROM stock_moves sm
  WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.id = sm.product_id);

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,63,'Intégrité','Mouvement de stock avec ref vente introuvable',
    'warning', sm.business_id,'stock_move',sm.id,
    'Mouvement #'||LEFT(sm.id::TEXT,8)||': ref_id='||sm.ref_id||' (vente introuvable)',
    1
  FROM stock_moves sm
  WHERE sm.ref_type IN ('vente','annulation')
    AND sm.ref_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM sale_orders so WHERE so.id = sm.ref_id);

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,64,'Intégrité','Ligne de vente avec variante supprimée',
    'critical', so.business_id,'so_line',sl.id,
    'Ligne #'||LEFT(sl.id::TEXT,8)||' (vente '||LEFT(so.id::TEXT,8)||
    '): variant_id='||sl.variant_id||' introuvable',
    1
  FROM so_lines sl
  JOIN sale_orders so ON so.id = sl.order_id
  WHERE sl.variant_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM product_variants pv WHERE pv.id = sl.variant_id);

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,65,'Intégrité','Ligne commande avec variante supprimée',
    'warning', po.business_id,'po_line',pol.id,
    'Ligne commande #'||LEFT(pol.id::TEXT,8)||
    ': variant_id='||pol.variant_id||' introuvable',
    1
  FROM po_lines pol
  JOIN purchase_orders po ON po.id = pol.po_id
  WHERE pol.variant_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM product_variants pv WHERE pv.id = pol.variant_id);

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,66,'Intégrité','Boutique sans membres',
    'critical', b.id,'business',b.id,
    'Boutique "'||b.name||'": aucun membre trouvé',
    1
  FROM businesses b
  WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.business_id = b.id);

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,67,'Intégrité','Paiements en double sur même vente',
    'warning', so.business_id,'sale_order',so.id,
    'Vente #'||LEFT(so.id::TEXT,8)||': '||COUNT(p.id)||
    ' paiements identiques ('||p.method||' '||p.amount||') le '||p.created_at::DATE,
    COUNT(p.id)::INT
  FROM sale_orders so
  JOIN payments p ON p.order_id = so.id
  GROUP BY so.business_id, so.id, p.method, p.amount, p.created_at::DATE
  HAVING COUNT(p.id) > 1;

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,68,'Intégrité','Dettes fournisseur > total des commandes',
    'warning', sd_agg.business_id,'business',sd_agg.business_id,
    'Boutique '||LEFT(sd_agg.business_id::TEXT,8)||
    ' fournisseur '||LEFT(sd_agg.supplier_id::TEXT,8)||
    ': dettes enregistrées='||sd_agg.total_debt||
    ' total commandes='||COALESCE(po_agg.total_cost,0)||
    ' (écart='||(sd_agg.total_debt - COALESCE(po_agg.total_cost,0))||')',
    1
  FROM (
    SELECT business_id, supplier_id, SUM(amount) AS total_debt
    FROM supplier_debts GROUP BY business_id, supplier_id
  ) sd_agg
  LEFT JOIN (
    SELECT business_id, supplier_id, SUM(total_cost) AS total_cost
    FROM purchase_orders WHERE status != 'annule'
    GROUP BY business_id, supplier_id
  ) po_agg ON po_agg.business_id = sd_agg.business_id
         AND po_agg.supplier_id = sd_agg.supplier_id
  WHERE sd_agg.total_debt > COALESCE(po_agg.total_cost, 0);

  -- ============================================================
  -- Finalise the run record
  -- ============================================================
  UPDATE reconciliation_runs SET
    completed_at      = now(),
    businesses_checked = v_biz_count,
    total_findings    = (SELECT COUNT(*)   FROM reconciliation_findings WHERE run_id = v_run_id),
    critical_count    = (SELECT COUNT(*)   FROM reconciliation_findings WHERE run_id = v_run_id AND severity = 'critical'),
    warning_count     = (SELECT COUNT(*)   FROM reconciliation_findings WHERE run_id = v_run_id AND severity = 'warning'),
    status            = CASE
      WHEN (SELECT COUNT(*) FROM reconciliation_findings WHERE run_id = v_run_id AND severity = 'critical') > 0
        THEN 'findings'
      WHEN (SELECT COUNT(*) FROM reconciliation_findings WHERE run_id = v_run_id AND severity = 'warning') > 0
        THEN 'findings'
      ELSE 'clean'
    END
  WHERE id = v_run_id;

  RETURN v_run_id;

EXCEPTION WHEN OTHERS THEN
  UPDATE reconciliation_runs SET
    completed_at = now(), status = 'error', error_detail = SQLERRM
  WHERE id = v_run_id;
  RAISE;
END;
$function$;

-- attach_transaction_proof: its READS of expenses go through expenses_visible; INSERT/UPDATE targets are unchanged (1 read(s))
CREATE OR REPLACE FUNCTION public.attach_transaction_proof(p_kind text, p_id uuid, p_image_url text, p_image_width integer DEFAULT NULL::integer, p_image_height integer DEFAULT NULL::integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_business_id uuid;
  v_created_by  uuid;
  v_status      text;
  v_existing    text;
  v_role        text;
BEGIN
  IF p_image_url IS NULL OR length(trim(p_image_url)) = 0 THEN
    RAISE EXCEPTION 'Image manquante' USING ERRCODE = 'P0001';
  END IF;

  IF p_kind = 'apport' THEN
    SELECT business_id, proof_image_url
      INTO v_business_id, v_existing
      FROM capital_injections WHERE id = p_id;
  ELSIF p_kind = 'expense' THEN
    SELECT business_id, created_by, status, proof_image_url
      INTO v_business_id, v_created_by, v_status, v_existing
      FROM expenses_visible WHERE id = p_id;
  ELSIF p_kind = 'purchase_order' THEN
    SELECT business_id, proof_image_url
      INTO v_business_id, v_existing
      FROM purchase_orders WHERE id = p_id;
  ELSE
    RAISE EXCEPTION 'Type de preuve inconnu' USING ERRCODE = 'P0001';
  END IF;

  IF v_business_id IS NULL THEN
    RAISE EXCEPTION 'Enregistrement introuvable' USING ERRCODE = 'P0001';
  END IF;

  v_role := get_role(v_business_id);

  IF p_kind = 'expense' THEN
    IF v_role IS NULL OR NOT (v_role IN ('administrateur', 'manager')
            OR (v_created_by = auth.uid() AND v_status = 'en_attente')) THEN
      RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    IF v_role IS NULL OR v_role NOT IN ('administrateur', 'manager') THEN
      RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF v_existing IS NOT NULL THEN
    RAISE EXCEPTION 'Une preuve est déjà attachée' USING ERRCODE = 'P0001';
  END IF;

  IF p_kind = 'apport' THEN
    UPDATE capital_injections
      SET proof_image_url    = p_image_url,
          proof_image_width  = p_image_width,
          proof_image_height = p_image_height,
          proof_attached_by  = auth.uid(),
          proof_attached_at  = now()
      WHERE id = p_id;
  ELSIF p_kind = 'expense' THEN
    UPDATE expenses
      SET proof_image_url    = p_image_url,
          proof_image_width  = p_image_width,
          proof_image_height = p_image_height,
          proof_attached_by  = auth.uid(),
          proof_attached_at  = now()
      WHERE id = p_id;
  ELSIF p_kind = 'purchase_order' THEN
    UPDATE purchase_orders
      SET proof_image_url    = p_image_url,
          proof_image_width  = p_image_width,
          proof_image_height = p_image_height,
          proof_attached_by  = auth.uid(),
          proof_attached_at  = now()
      WHERE id = p_id;
  END IF;
END;
$function$;

-- delete_transaction_proof: its READS of expenses go through expenses_visible; INSERT/UPDATE targets are unchanged (1 read(s))
CREATE OR REPLACE FUNCTION public.delete_transaction_proof(p_kind text, p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_business_id   uuid;
  v_attached_by   uuid;
  v_attached_at   timestamptz;
  v_existing      text;
BEGIN
  IF p_kind = 'apport' THEN
    SELECT business_id, proof_image_url, proof_attached_by, proof_attached_at
      INTO v_business_id, v_existing, v_attached_by, v_attached_at
      FROM capital_injections WHERE id = p_id;
  ELSIF p_kind = 'expense' THEN
    SELECT business_id, proof_image_url, proof_attached_by, proof_attached_at
      INTO v_business_id, v_existing, v_attached_by, v_attached_at
      FROM expenses_visible WHERE id = p_id;
  ELSIF p_kind = 'purchase_order' THEN
    SELECT business_id, proof_image_url, proof_attached_by, proof_attached_at
      INTO v_business_id, v_existing, v_attached_by, v_attached_at
      FROM purchase_orders WHERE id = p_id;
  ELSE
    RAISE EXCEPTION 'Type de preuve inconnu' USING ERRCODE = 'P0001';
  END IF;

  IF v_business_id IS NULL OR v_existing IS NULL THEN
    RAISE EXCEPTION 'Aucune image à supprimer' USING ERRCODE = 'P0001';
  END IF;

  -- Deliberately narrower than attach's role gate: not admin/manager in
  -- general, specifically whoever ran the attach call — matches the exact
  -- rule requested ("only the person that added it can delete it").
  IF v_attached_by IS NULL OR v_attached_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF v_attached_at IS NULL OR now() - v_attached_at > interval '24 hours' THEN
    RAISE EXCEPTION 'Le délai de 24 heures pour supprimer cette image est dépassé' USING ERRCODE = 'P0001';
  END IF;

  IF p_kind = 'apport' THEN
    UPDATE capital_injections
      SET proof_image_url = NULL, proof_image_width = NULL, proof_image_height = NULL,
          proof_attached_by = NULL, proof_attached_at = NULL
      WHERE id = p_id;
  ELSIF p_kind = 'expense' THEN
    UPDATE expenses
      SET proof_image_url = NULL, proof_image_width = NULL, proof_image_height = NULL,
          proof_attached_by = NULL, proof_attached_at = NULL
      WHERE id = p_id;
  ELSIF p_kind = 'purchase_order' THEN
    UPDATE purchase_orders
      SET proof_image_url = NULL, proof_image_width = NULL, proof_image_height = NULL,
          proof_attached_by = NULL, proof_attached_at = NULL
      WHERE id = p_id;
  END IF;
END;
$function$;
