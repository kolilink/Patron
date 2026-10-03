-- ============================================================
-- E2E FIX BATCH E — social & reports. TEST DB only — do not commit.
-- ============================================================
-- 5. Accueil "N ventes aujourd'hui" flips after a credit-sale day.
--
--    get_dashboard_kpis() (migration_v199) counted sales_today as
--    `status = 'paye' AND paid_at >= v_today_ts` — cash-only and anchored
--    on paid_at. But Accueil's own local-first estimate
--    (app/(app)/(tabs)/index.tsx computeLocalKpis) counts
--    `status !== 'annule'` anchored on `COALESCE(sale_date, created_at::date)`.
--    On a day with only carnet credit sales the local overlay showed
--    "N ventes aujourd'hui", then the background RPC refresh overwrote it
--    with 0 (credit never matched status='paye') — the number visibly
--    flipped down a beat after the screen rendered.
--
--    This rewrite aligns the server with the client's local formula so the
--    two never disagree:
--      * sales_today  — every non-annulée sale dated today (paye OR credit).
--      * revenue_today — only cash (non-credit) sales dated today, matching
--        computeLocalKpis' `todaySales.filter(s => !s.is_credit)`.
--
--    yesterday/month revenue stay paid_at/status='paye' based (the client
--    reads those straight from the RPC cache and never recomputes them).
--
--    Returns jsonb, so CREATE OR REPLACE keeps the same signature —
--    no DROP FUNCTION / GRANT changes needed beyond re-granting below.

CREATE OR REPLACE FUNCTION public.get_dashboard_kpis(
  p_business_id uuid,
  p_today       date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
BEGIN
  IF NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  -- Count today — every non-annulée sale dated today (matches
  -- computeLocalKpis: status !== 'annule' AND COALESCE(sale_date,
  -- created_at::date) === today). Credit sales count; they are sales.
  SELECT COUNT(*)::int
  INTO v_sales_today
  FROM sale_orders
  WHERE business_id = p_business_id
    AND status <> 'annule'
    AND COALESCE(sale_date, created_at::date) = v_today;

  -- Revenue today — only cash (non-credit) sales, same local formula
  -- (todaySales.filter(s => !s.is_credit)).
  SELECT COALESCE(SUM(total_amount - COALESCE(discount_amount, 0)), 0)
  INTO v_revenue_today
  FROM sale_orders
  WHERE business_id = p_business_id
    AND status <> 'annule'
    AND COALESCE(sale_date, created_at::date) = v_today
    AND NOT is_credit;

  -- Revenue yesterday
  SELECT COALESCE(SUM(total_amount - COALESCE(discount_amount, 0)), 0)
  INTO v_revenue_yesterday
  FROM sale_orders
  WHERE business_id = p_business_id
    AND status      = 'paye'
    AND paid_at    >= v_yest_ts
    AND paid_at     < v_today_ts;

  -- Revenue this month
  SELECT COALESCE(SUM(total_amount - COALESCE(discount_amount, 0)), 0)
  INTO v_revenue_month
  FROM sale_orders
  WHERE business_id = p_business_id
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
$$;

GRANT EXECUTE ON FUNCTION public.get_dashboard_kpis(uuid, date) TO authenticated;
