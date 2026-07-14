-- ============================================================
-- Patron — Migration v82
-- Run in Supabase SQL Editor AFTER migration_v81
--
-- Update get_order_cogs to use the snapshotted cost_price_at_sale
-- from so_lines (added in v81) rather than joining to the current
-- products/product_variants tables.
--
-- For historical rows where cost_price_at_sale IS NULL (written
-- before v81), the function falls back to the current cost_price
-- from products/product_variants — same behaviour as before,
-- so old reports are unchanged until those products get a new
-- delivery and their cost_price shifts.
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
    SUM(
      COALESCE(
        sl.cost_price_at_sale,
        pv.cost_price,
        p.cost_price,
        0
      ) * sl.qty
    )::bigint AS cogs_cents
  FROM so_lines sl
  JOIN products p               ON p.id  = sl.product_id
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
