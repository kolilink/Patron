-- ============================================================
-- Patron — Migration v85
-- Run in Supabase SQL Editor AFTER migration_v84
--
-- One-time backfill of cost_price_at_sale on all historical
-- so_lines that have NULL (i.e. written before migration_v81).
--
-- We cannot time-travel to the exact cost at each past sale,
-- so we use the current cost_price as a one-time approximation.
-- This freezes historical COGS permanently — future PO receipts
-- and AVCO updates will no longer shift past profit figures.
--
-- Variant lines use product_variants.cost_price (preferred),
-- falling back to products.cost_price — same priority order
-- as get_order_cogs and get_product_stats.
--
-- Cancelled orders are left as NULL (they are excluded from
-- all COGS calculations anyway).
-- ============================================================

UPDATE so_lines
SET cost_price_at_sale = (
  SELECT COALESCE(pv.cost_price, p.cost_price, 0)
  FROM products p
  LEFT JOIN product_variants pv ON pv.id = so_lines.variant_id
  WHERE p.id = so_lines.product_id
)
WHERE cost_price_at_sale IS NULL
  AND order_id IN (
    SELECT id FROM sale_orders WHERE status != 'annule'
  );
