-- ============================================================
-- migration_v234 — Expense flow redesign: soft delete, enforced by the DB
--
-- (expenses.product_id already exists since migration_v84: nullable FK,
--  ON DELETE SET NULL — deleting a product never destroys expense history.
--  Link is metadata only; nothing here touches stock.)
--
-- Why a restrictive policy: every app-role query (list, month total, any
-- future screen) is filtered by the DATABASE, so no query can forget
-- `deleted_at IS NULL`. A RESTRICTIVE policy ANDs with the existing
-- permissive ones (v2/v19/v30/v38/v66) without rewriting them.
-- SECURITY DEFINER report functions bypass RLS, so each one that sums
-- expenses is re-issued below with the filter (7 functions).
-- run_reconciliation() is deliberately unchanged: its checks are row
-- integrity checks, not totals.
--
-- Soft delete/restore are RPCs, not direct UPDATEs: the restrictive policy
-- (correctly) forbids an app role writing a row into an invisible state, and
-- a deleted row is invisible, so restore can only be a definer function.
-- Both are idempotent so an outbox replay is harmless.
-- ============================================================

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS deleted_at timestamptz NULL;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS deleted_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_expenses_deleted
  ON expenses (business_id) WHERE deleted_at IS NOT NULL;

DROP POLICY IF EXISTS "Dépenses supprimées: invisibles" ON expenses;
CREATE POLICY "Dépenses supprimées: invisibles"
  ON expenses AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (deleted_at IS NULL);

-- Who may delete: admin/manager any expense; the creator only their own
-- expense while it is still pending (the vendeur undoing a fresh entry).
CREATE OR REPLACE FUNCTION soft_delete_expense(p_expense_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_exp expenses%ROWTYPE;
  v_role text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Connexion requise.';
  END IF;
  SELECT * INTO v_exp FROM expenses WHERE id = p_expense_id;
  IF NOT FOUND THEN
    RETURN true;                          -- nothing to delete (idempotent)
  END IF;
  v_role := get_role(v_exp.business_id);
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Vous ne pouvez pas supprimer cette dépense.';
  END IF;
  IF NOT (v_role IN ('administrateur','manager')
          OR (v_exp.created_by = auth.uid() AND v_exp.status = 'en_attente')) THEN
    RAISE EXCEPTION 'Vous ne pouvez pas supprimer cette dépense.';
  END IF;
  IF v_exp.deleted_at IS NOT NULL THEN
    RETURN true;
  END IF;
  UPDATE expenses SET deleted_at = now(), deleted_by = auth.uid() WHERE id = p_expense_id;
  RETURN true;
END;
$$;

-- Undo of a delete: only the person who deleted it, within 24h (long enough
-- for an undo queued offline to replay; support restores older ones by hand).
CREATE OR REPLACE FUNCTION restore_expense(p_expense_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_exp expenses%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Connexion requise.';
  END IF;
  SELECT * INTO v_exp FROM expenses WHERE id = p_expense_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cette dépense est introuvable.';
  END IF;
  IF v_exp.deleted_at IS NULL THEN
    RETURN true;                          -- already live (idempotent)
  END IF;
  IF get_role(v_exp.business_id) IS NULL
     OR v_exp.deleted_by IS DISTINCT FROM auth.uid()
     OR v_exp.deleted_at < now() - interval '24 hours' THEN
    RAISE EXCEPTION 'Vous ne pouvez pas rétablir cette dépense.';
  END IF;
  UPDATE expenses SET deleted_at = NULL, deleted_by = NULL WHERE id = p_expense_id;
  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION soft_delete_expense(uuid), restore_expense(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION soft_delete_expense(uuid), restore_expense(uuid) TO authenticated;

-- ─── Report functions: sum live rows only ─────────────────────────────────────

-- get_business_kpis: live expenses only (1 read(s))
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
      SELECT SUM(amount) FROM expenses
      WHERE deleted_at IS NULL AND business_id = p_business_id AND status = 'approuve'
        AND date >= v_month_date
    ), 0)
  );
END;
$function$;

-- get_product_stats: live expenses only (1 read(s))
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
  FROM expenses
  WHERE deleted_at IS NULL AND product_id   = p_product_id
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

-- get_dashboard_kpis: live expenses only (1 read(s))
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
  FROM expenses
  WHERE deleted_at IS NULL AND business_id = p_business_id
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

-- get_financial_snapshot: live expenses only (2 read(s))
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
    FROM expenses e JOIN businesses b ON b.id = e.business_id
    WHERE e.deleted_at IS NULL AND e.status = 'approuve' AND e.date >= v_today
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
    FROM expenses e JOIN businesses b ON b.id = e.business_id
    WHERE e.deleted_at IS NULL AND e.status = 'approuve' AND e.date >= v_month_start
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

-- get_reports_snapshot: live expenses only (3 read(s))
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
    FROM expenses e
    WHERE e.deleted_at IS NULL AND e.business_id = p_business_id
      AND e.status = 'approuve'
      AND (e.category IS NULL OR e.category <> 'transport_achat')
      AND e.date >= v_period_start
      AND e.date <= p_today;

    -- Shipping expenses shown as a separate informational line.
    -- NOT deducted from net_profit (already in COGS via AVCO).
    SELECT COALESCE(SUM(e.amount), 0)
    INTO v_shipping_exp
    FROM expenses e
    WHERE e.deleted_at IS NULL AND e.business_id = p_business_id
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
      - COALESCE((SELECT SUM(amount)     FROM expenses WHERE deleted_at IS NULL AND business_id = p_business_id AND status = 'approuve'), 0)
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

-- get_period_report: live expenses only (2 read(s))
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
    FROM expenses e
    WHERE e.deleted_at IS NULL AND e.business_id = p_business_id
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
      - COALESCE((SELECT SUM(amount)       FROM expenses WHERE deleted_at IS NULL AND business_id = p_business_id AND status = 'approuve'), 0)
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

-- run_display_checks: live expenses only (2 read(s))
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
      - COALESCE((SELECT SUM(amount)       FROM expenses WHERE deleted_at IS NULL AND business_id = b.id AND status = 'approuve'), 0)
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
  FROM expenses e
  WHERE e.deleted_at IS NULL AND e.category = 'transport_achat'
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
