-- ============================================================
-- Patron — Migration v158
-- Run in Supabase SQL Editor AFTER migration_v157
--
-- Per-variant pricing (catalogue.tsx's "Nouveau produit"/"Modifier le
-- produit" variant rows now expose an independently editable
-- product_variants.sale_price, not just a value cloned once from the
-- parent product at creation time) opened a real blind spot in the
-- nightly reconciliation report: checks 42 ("Coût de revient > prix de
-- vente") and 46 ("Prix de vente anormalement bas — ×100 oublié ?"),
-- both in run_reconciliation() (migration_v99.sql / carried forward
-- unchanged through v107.sql), only ever look at products.sale_price /
-- products.cost_price. Once a merchant can price one variant below its
-- own cost, or fat-finger a raw-GNF amount into a variant's price field
-- the same way the whole-unit-currency ×100 mistake has already bitten
-- this app on the product-level field, neither mistake is visible to
-- either check — they only ever read the parent row, never
-- product_variants.
--
-- Rather than reproduce run_reconciliation()'s ~1000-line body via
-- CREATE OR REPLACE (all 68 existing checks would have to be retyped by
-- hand into this file, pure transcription risk for zero behavior
-- change), this follows the exact same additive pattern
-- run_display_checks(p_run_id) already established for checks 69-80: a
-- separate, small, single-purpose function that inserts findings into
-- the same run via p_run_id, called from _shared/reconciliation.ts
-- right alongside run_display_checks — see that file's runReconciliation()
-- for the call site. Nothing about the existing 80 checks is touched.
--
-- Checks 81-82 are the variant-scoped twins of 42 and 46, same severity,
-- same wording style, same thresholds — only the table changed.
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

END;
$$;

GRANT EXECUTE ON FUNCTION run_variant_price_checks(uuid) TO service_role;
