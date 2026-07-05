-- ============================================================
-- Patron — Migration v71
-- Run in Supabase SQL Editor AFTER migration_v70
--
-- Integrity: move dashboard KPI aggregation to the DB.
-- get_dashboard_kpis() replaces 6+ client-side queries in
-- the Accueil tab with a single atomic call. All math
-- (revenue, credit balance, low-stock count) now happens in
-- one transaction so every number reflects the same instant.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_dashboard_kpis(p_business_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today          date        := CURRENT_DATE;
  v_yesterday      date        := CURRENT_DATE - 1;
  v_month_start    date        := date_trunc('month', CURRENT_DATE)::date;
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
BEGIN
  IF NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  -- Revenue + count today (paid_at >= start of today UTC)
  SELECT
    COUNT(*)::int,
    COALESCE(SUM(total_amount - COALESCE(discount_amount, 0)), 0)
  INTO v_sales_today, v_revenue_today
  FROM sale_orders
  WHERE business_id = p_business_id
    AND status      = 'paye'
    AND paid_at    >= v_today_ts;

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

  -- Credit total (remaining owed) + distinct debtor count.
  -- remaining = total - discount - sum(payments). Count distinct names for named
  -- clients; count rows for anonymous orders (no customer_name).
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

  -- Low-stock count: plain products + individual variants below reorder level
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
    'low_stock',         v_low_stock
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_dashboard_kpis(uuid) TO authenticated;
