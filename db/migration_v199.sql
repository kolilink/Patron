-- ============================================================
-- Patron — Migration v199
-- Run in Supabase SQL Editor AFTER migration_v198
--
-- Adds first_sale_at to get_dashboard_kpis() — backs Accueil's one-time
-- "Première vente notée ✓" acknowledgment (see app/(app)/(tabs)/index.tsx's
-- comparisonText). The dashboard's own "Bienvenue" line used to be keyed on
-- businesses.created_at ("was this business created today"), which is the
-- wrong signal: a business created today but already busy (real test data,
-- or a genuinely fast first day) would show "Bienvenue" right alongside
-- real sales already on the board — and, once a single calendar day passed,
-- "Bienvenue" silently stopped being shown at all regardless of whether the
-- business had actually made its first sale yet.
--
-- first_sale_at is the timestamp of the business's very first status='paye'
-- sale, lifetime, or null if none yet — a plain read-only aggregate, not a
-- stamped column. No write-side changes needed on submit_sale/
-- submit_quick_sale (both already write status='paye') or anywhere else;
-- this is computed fresh on every call, same posture as every other field
-- in this function. Deliberately excludes status='credit' — a carnet debt
-- is not "a sale" for this purpose (confirmed by direct product spec:
-- "if her first action was a debt and she has no sales yet, the sales slot
-- stays Bienvenue"), so submit_carnet_debt's rows never touch this MIN().
--
-- Business-wide, not seller-scoped — same posture as every other field
-- get_dashboard_kpis already returns. Since this SECURITY DEFINER function
-- bypasses the caller's own RLS, a vendeur sees the business's true first
-- sale (possibly made by someone else, or before they joined), not just
-- their own — correct, since "Première vente notée ✓" is a fact about the
-- business, not about whoever happens to be looking at Accueil right now.
--
-- Returns jsonb (not RETURNS TABLE), so adding a field needs no DROP
-- FUNCTION / signature change — CREATE OR REPLACE is safe as-is.
-- ============================================================

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

  -- Revenue + count today
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
