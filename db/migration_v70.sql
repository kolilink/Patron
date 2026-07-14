-- ============================================================
-- Patron — Migration v70
-- Run in Supabase SQL Editor AFTER migration_v69
--
-- Fix: get_best_sellers was including archived products.
-- Add AND p.archived = false to exclude them from rankings.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_best_sellers(
  p_business_id uuid,
  p_month_start date,
  p_limit       int DEFAULT 5
)
RETURNS TABLE(
  product_id    uuid,
  product_name  text,
  total_qty     numeric,
  total_revenue numeric
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT
    sl.product_id,
    p.name           AS product_name,
    SUM(sl.qty)                  AS total_qty,
    SUM(sl.qty * sl.unit_price)  AS total_revenue
  FROM so_lines sl
  JOIN products p     ON p.id  = sl.product_id
  JOIN sale_orders so ON so.id = sl.order_id
  WHERE so.business_id = p_business_id
    AND so.status IN ('paye', 'credit')
    AND so.sale_date >= p_month_start
    AND p.archived = false
  GROUP BY sl.product_id, p.name
  ORDER BY total_revenue DESC
  LIMIT p_limit;
$$;
