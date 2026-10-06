-- migration_v232 — Phase 9, Finding 4: report RPCs vs roles.
--
-- SECURITY DEFINER functions bypass RLS, so the boundary the app draws in the
-- UI must be enforced INSIDE each one. Audit of every report RPC (each called
-- directly, as each role, in __tests__/integration/phase9-report-role-gates):
--
--   get_reports_snapshot / get_period_report  HELD already. Role is derived
--       server-side from get_role()/auth.uid() (v121); a vendeur gets only
--       my_* fields and every business-wide money field is 0/empty. anon has no
--       EXECUTE (v226). Not changed here; the new tests pin it.
--       NOTE (decision recorded in the PR): investisseur is deliberately inside
--       the whole-business block — the app renders it for them (Rapports profit
--       hero, Accueil "bénéfice ce mois") — so it is NOT narrowed here.
--   get_best_sellers      LEAKED business-wide product revenue to a vendeur
--       (is_member only). Now: vendeur -> only their own sales (the same scope
--       RLS gives them on sale_orders); admin/manager/investisseur unchanged.
--       get_best_sellers_unchecked stays service_role-only (re-asserted).
--   get_order_cogs        LEAKED business-wide cost of goods to any member.
--       No client calls it (reconciliation uses the service_role *_unchecked
--       twin) -> admin/manager only.
--   get_dashboard_kpis    (found by this audit, not in the original list)
--       LEAKED business-wide revenue/credit/expenses to a vendeur's Accueil.
--       Now every sale/expense aggregate is narrowed to the vendeur's own rows.
--       first_sale_at stays business-wide on purpose (v199: a fact about the
--       business, not a figure).
--   get_product_stats     (found by this audit) returns capital (qty x cost)
--       and profit: cost data a vendeur cannot read from the tables since v193.
--       Refused for vendeur.
--
-- Grants: anon never needs these (every caller is a signed-in session; an
-- anonymous-auth user is role `authenticated`), so EXECUTE is revoked from
-- PUBLIC and anon on all of them plus get_stock_velocity (same exposure class,
-- body already guards membership; grant-only change).

CREATE OR REPLACE FUNCTION public.get_best_sellers(p_business_id uuid, p_month_start date, p_limit integer DEFAULT 5)
 RETURNS TABLE(product_id uuid, product_name text, total_qty numeric, total_revenue numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF get_role(p_business_id) = 'vendeur' THEN
    -- Own sales only (same predicate as the unchecked body + seller scope).
    -- Explicit ::numeric casts so RETURN QUERY matches the declared types on any
    -- so_lines.unit_price column type (see migration_v231 / v228 notes).
    RETURN QUERY
      SELECT sl.product_id,
             p.name,
             SUM(sl.qty)::numeric,
             SUM(sl.qty * sl.unit_price)::numeric
      FROM so_lines sl
      JOIN products p     ON p.id  = sl.product_id
      JOIN sale_orders so ON so.id = sl.order_id
      WHERE so.business_id = p_business_id
        AND so.seller_id   = auth.uid()
        AND so.status IN ('paye', 'credit')
        AND so.sale_date >= p_month_start
        AND p.archived = false
        AND p.is_system = false
      GROUP BY sl.product_id, p.name
      ORDER BY SUM(sl.qty * sl.unit_price) DESC
      LIMIT p_limit;
  ELSE
    RETURN QUERY SELECT * FROM public.get_best_sellers_unchecked(p_business_id, p_month_start, p_limit);
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_order_cogs(p_business_id uuid, p_since_date date)
 RETURNS TABLE(order_id uuid, cogs_cents bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;
  IF COALESCE(get_role(p_business_id), '') NOT IN ('administrateur', 'manager') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY SELECT * FROM public.get_order_cogs_unchecked(p_business_id, p_since_date);
END;
$function$;

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

REVOKE ALL ON FUNCTION public.get_best_sellers(uuid, date, integer)              FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_order_cogs(uuid, date)                         FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_dashboard_kpis(uuid, date)                     FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_product_stats(uuid, uuid, timestamp with time zone) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_stock_velocity(uuid)                           FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_best_sellers(uuid, date, integer)              TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_order_cogs(uuid, date)                         TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_dashboard_kpis(uuid, date)                     TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_product_stats(uuid, uuid, timestamp with time zone) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_stock_velocity(uuid)                           TO authenticated, service_role;

-- Re-assert (v228): the unchecked twins are service_role only.
REVOKE ALL ON FUNCTION public.get_best_sellers_unchecked(uuid, date, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_order_cogs_unchecked(uuid, date)            FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_best_sellers_unchecked(uuid, date, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_order_cogs_unchecked(uuid, date)            TO service_role;
