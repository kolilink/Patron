-- ============================================================
-- Patron — Migration v98
-- Run in Supabase SQL Editor AFTER migration_v97
--
-- Backfill: restore product_variants.stock_qty for variant sales
-- that were cancelled before v96 fixed cancel_sale.
--
-- Root cause: cancel_sale (from v22 through v95) never touched
-- product_variants.stock_qty. From v86 onwards, submit_sale
-- correctly decremented variant stock on every sale — but
-- cancellations never restored it, leaving variant stock
-- permanently understated by the quantity of cancelled items.
--
-- Filter: so_lines.cost_price_at_sale IS NOT NULL means the sale
-- was processed by submit_sale v81+. Since v86 (variant deduction)
-- and v81 (cost snapshot) were applied together, these are the
-- same rows that had variant stock properly decremented at sale
-- time. Only those lines need restoration on cancel.
--
-- SAFETY: run the diagnostic SELECT below FIRST, compare
-- "stock_corrige" against your physical count per variant.
-- If a variant doesn't match, adjust manually via the
-- stock adjustment screen — do not run the UPDATE blindly.
-- ============================================================

-- ── Step 1 — Diagnostic (no changes, run first) ───────────────────────────────
--
-- SELECT
--   p.name                                     AS produit,
--   pv.name                                    AS variante,
--   pv.stock_qty                               AS stock_actuel,
--   SUM(sl.qty)                                AS unites_a_restaurer,
--   pv.stock_qty + SUM(sl.qty)                 AS stock_corrige
-- FROM so_lines sl
-- JOIN sale_orders so      ON so.id  = sl.order_id
-- JOIN product_variants pv ON pv.id  = sl.variant_id
-- JOIN products p          ON p.id   = pv.product_id
-- WHERE so.status               = 'annule'
--   AND sl.variant_id           IS NOT NULL
--   AND sl.cost_price_at_sale   IS NOT NULL
-- GROUP BY p.name, pv.name, pv.id, pv.stock_qty
-- ORDER BY p.name, pv.name;

-- ── Step 2 — Apply fix ────────────────────────────────────────────────────────

UPDATE product_variants pv
SET stock_qty = pv.stock_qty + backfill.qty_to_restore
FROM (
  SELECT
    sl.variant_id,
    SUM(sl.qty) AS qty_to_restore
  FROM so_lines sl
  JOIN sale_orders so ON so.id = sl.order_id
  WHERE so.status             = 'annule'
    AND sl.variant_id         IS NOT NULL
    AND sl.cost_price_at_sale IS NOT NULL
  GROUP BY sl.variant_id
) backfill
WHERE pv.id = backfill.variant_id;
