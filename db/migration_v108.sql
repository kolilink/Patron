-- ============================================================
-- Patron — Migration v108
-- Run in Supabase SQL Editor AFTER migration_v107
--
-- Closes the last real gap from the unit_price consolidation
-- (v107): the original v94 backfill (which computed the real
-- price for above-catalog sales into unit_price_paid) explicitly
-- excluded cancelled orders ("AND so.status != 'annule'"). v107's
-- backfill only copied unit_price_paid → unit_price for rows that
-- already had a value, so those cancelled orders' so_lines were
-- never corrected and still showed a stale catalog-price total.
--
-- Confirmed via a fresh reconciliation run after v107: 3 orders
-- (Maillot, Alkogguiwy Shop, BMA — all status='annule') still had
-- a real (non-rounding) gap between total_amount and the so_lines
-- sum. No revenue/COGS/profit figure is affected by this — every
-- reporting query filters to status IN ('paye','credit'), which
-- already excludes cancelled sales. This is purely an internal
-- consistency fix so check #9 (and any future query that doesn't
-- think to exclude 'annule') gives a correct answer regardless of
-- status.
--
-- Same formula as v94, with the status filter removed.
-- ============================================================

WITH catalog_totals AS (
  SELECT order_id, SUM(unit_price * qty) AS catalog_total
  FROM so_lines
  GROUP BY order_id
)
UPDATE so_lines sl
SET unit_price = ROUND(
  sl.unit_price::numeric
  * so.total_amount::numeric
  / ct.catalog_total::numeric
)
FROM sale_orders so
JOIN catalog_totals ct ON ct.order_id = so.id
WHERE sl.order_id = so.id
  AND so.status IN ('paye','credit','annule')
  AND ct.catalog_total > 0
  AND so.total_amount != ct.catalog_total;
