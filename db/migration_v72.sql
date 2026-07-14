-- ============================================================
-- Patron — Migration v72
-- Run in Supabase SQL Editor AFTER migration_v71
--
-- Integrity: move COGS aggregation to the DB.
-- get_order_cogs() computes cost-of-goods-sold per order
-- server-side, replacing the client-side so_lines loop in
-- stores/rapports.ts. Variant cost_price is preferred over
-- parent product cost_price, matching the POS pricing logic.
-- Only orders with at least one payment since p_since_date
-- and status != 'annule' are included.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_order_cogs(
  p_business_id uuid,
  p_since_date  date
)
RETURNS TABLE(order_id uuid, cogs_cents bigint)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT
    sl.order_id,
    SUM(COALESCE(pv.cost_price, p.cost_price, 0) * sl.qty)::bigint AS cogs_cents
  FROM so_lines sl
  JOIN products p          ON p.id  = sl.product_id
  LEFT JOIN product_variants pv ON pv.id = sl.variant_id
  WHERE sl.order_id IN (
    SELECT DISTINCT pay.order_id
    FROM payments pay
    JOIN sale_orders so ON so.id = pay.order_id
    WHERE so.business_id = p_business_id
      AND so.status     != 'annule'
      AND pay.date      >= p_since_date
  )
  GROUP BY sl.order_id;
$$;

GRANT EXECUTE ON FUNCTION public.get_order_cogs(uuid, date) TO authenticated;
