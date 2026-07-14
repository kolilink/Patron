-- ============================================================
-- Patron — Migration v94
-- Run in Supabase SQL Editor AFTER migration_v93
--
-- Backfill unit_price_paid for historical so_lines where the
-- merchant charged above catalog price (overrideTotalAmount flow).
--
-- Logic: same priceRatio the frontend applies at checkout —
--   unit_price_paid = ROUND(unit_price × total_amount / catalog_total)
-- Only runs on non-cancelled orders where total_amount > catalog_total
-- and unit_price_paid is not yet set.
-- ============================================================

UPDATE so_lines sl
SET unit_price_paid = ROUND(
  sl.unit_price::numeric
  * so.total_amount::numeric
  / order_totals.catalog_total::numeric
)
FROM sale_orders so
JOIN (
  SELECT order_id, SUM(unit_price * qty) AS catalog_total
  FROM so_lines
  GROUP BY order_id
) order_totals ON order_totals.order_id = so.id
WHERE sl.order_id = so.id
  AND sl.unit_price_paid IS NULL
  AND so.status != 'annule'
  AND order_totals.catalog_total > 0
  AND so.total_amount > order_totals.catalog_total;
