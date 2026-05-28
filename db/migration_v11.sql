-- ============================================================
-- Patron — Migration v11
-- Run in Supabase SQL Editor AFTER migration_v10
-- ============================================================

-- SECURITY DEFINER function so all roles (including investisseur)
-- can read aggregated business KPIs without direct table access.
-- Caller must be an active member of the business.

CREATE OR REPLACE FUNCTION public.get_business_kpis(p_business_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
      WHERE business_id = p_business_id AND status = 'approuve'
        AND date >= v_month_date
    ), 0)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_business_kpis(uuid) TO authenticated;
