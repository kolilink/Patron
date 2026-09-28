-- ============================================================
-- Patron — Migration v159
-- Run in Supabase SQL Editor AFTER migration_v158
--
-- Two of the app's purchase-order screens are hand-duplicated
-- implementations of "create a commande" (app/(app)/fournisseurs/index.tsx's
-- list-flow CommandeForm, and app/(app)/fournisseurs/[id].tsx's own
-- supplier-detail-page CommandeForm), and they'd drifted apart: the first
-- correctly threads a picked variant's id into po_lines.variant_id, the
-- second visually broke a variant product into one line per variant but
-- silently dropped variant_id before the insert — every line it created
-- landed as a plain, variant-less po_lines row regardless of which variant
-- was shown on screen. Fixed at the app layer (this migration doesn't touch
-- that — see [id].tsx and stores/fournisseurs.ts's createCommande/
-- loadCommandeLines/receiving-screen changes shipped alongside this file).
--
-- This migration adds the detective backstop: check 83, the variant-scoped
-- twin of the same "did the money/stock land somewhere real" instinct
-- behind every other check in this suite. A po_lines row that's actually
-- been received (qty_received > 0) for a has_variants product but carries
-- no variant_id means that stock and AVCO-computed cost landed on the
-- parent product instead of any real variant — silently drifting the
-- parent's stock_qty/cost_price away from the "always 0 / template only"
-- invariant this app already relies on elsewhere (migration_v125,
-- ProductRow/ProductTile's out-of-stock aggregation). Scoped to the last 90
-- days, same window check 79 already uses, so historical POs from before
-- this fix existed don't permanently flood the nightly report.
--
-- Same additive-function pattern as v158: CREATE OR REPLACE carries
-- forward checks 81-82 unchanged and appends 83 — nothing about the
-- existing 82 checks changes.
-- ============================================================

CREATE OR REPLACE FUNCTION run_variant_price_checks(p_run_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN

  -- 81. Variant: cost price exceeds sale price (guaranteed loss on every sale)
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT p_run_id,81,'Produits','Variante : coût de revient > prix de vente',
    'warning', pv.business_id,'product_variant',pv.id,
    'Variante "'||p.name||' — '||pv.name||'": cost_price='||pv.cost_price||
    ' > sale_price='||pv.sale_price||' (vente à perte systématique)',
    1
  FROM product_variants pv
  JOIN products p ON p.id = pv.product_id
  WHERE pv.cost_price > pv.sale_price
    AND pv.archived = false AND pv.cost_price > 0;

  -- 82. Variant: sale price suspiciously small (×100 multiplication forgotten?)
  --     Same BIGINT-cents convention as check 46 — sale_price < 100 means
  --     less than 1 whole currency unit, almost never intentional.
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT p_run_id,82,'Montants','Variante : prix de vente anormalement bas (×100 oublié ?)',
    'warning', pv.business_id,'product_variant',pv.id,
    'Variante "'||p.name||' — '||pv.name||'": sale_price='||pv.sale_price||
    ' centimes ('||(pv.sale_price/100.0)||' unité) — vérifier multiplication ×100',
    1
  FROM product_variants pv
  JOIN products p ON p.id = pv.product_id
  WHERE pv.sale_price > 0 AND pv.sale_price < 100
    AND pv.archived = false;

  -- 83. Received PO line on a variant product with no variant assigned —
  -- the received stock/cost landed on the parent, not any real variant.
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT p_run_id,83,'Commandes','Réception sans variante assignée',
    'warning', po.business_id,'po_line',pol.id,
    'Commande #'||LEFT(po.id::TEXT,8)||' — produit "'||p.name||'" : '||pol.qty_received||
    ' reçu(s) sans variante précisée (le produit a pourtant des variantes)',
    1
  FROM po_lines pol
  JOIN purchase_orders po ON po.id = pol.po_id
  JOIN products p ON p.id = pol.product_id
  WHERE p.has_variants = true
    AND pol.variant_id IS NULL
    AND pol.qty_received > 0
    AND po.ordered_at >= now() - interval '90 days';

END;
$$;

GRANT EXECUTE ON FUNCTION run_variant_price_checks(uuid) TO service_role;
