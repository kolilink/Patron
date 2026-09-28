-- ============================================================
-- Patron — Migration v189
-- Run in Supabase SQL Editor AFTER migration_v188
--
-- "Restructuration Fournisseurs — les livraisons": the reception wizard's
-- old mandatory "Qui ?" step (pick a supplier before anything else) was
-- removed in favor of a skippable "De : —" chip on the Confirmé step —
-- i.e. AFTER confirm_reception() has already run, already created the
-- purchase_order, and already linked any brand-new product to whichever
-- supplier resolved at that moment (a real one, or the "Marché" placeholder
-- via resolve_reception_supplier(), migration_v188.sql). Picking a supplier
-- on that chip therefore has to be a genuine post-save UPDATE, not just a
-- client-side draft patch — without this RPC, tapping the chip silently did
-- nothing to the actual saved record (found by tracing the flow end-to-end
-- after the copy pass that moved the chip, not from a bug report).
--
-- update_reception_supplier() reassigns the purchase_order's own
-- supplier_id, and re-links any product that's still pointing at the OLD
-- supplier and appears as a line on this exact po. Deliberately scoped this
-- narrowly (not "every product this supplier has ever touched") for two
-- reasons: (1) it's the only case this RPC needs to handle — the chip only
-- exists to fix a réception she just recorded a moment ago; (2) a product
-- that was already linked to some other supplier before this po ever
-- touched it is never silently reassigned just because it happens to share
-- the po's old supplier_id — only genuinely this-po's-own line products
-- move. This can't perfectly distinguish "created fresh by this po" from
-- "pre-existing product that happened to already carry the old supplier,"
-- but that's a low-probability, low-severity edge case (a mislabeled
-- supplier chip, not lost data, and correctable the same way any product's
-- supplier link is corrected elsewhere) — not worth a full line-provenance
-- column for this pass.
-- ============================================================

CREATE OR REPLACE FUNCTION public.update_reception_supplier(
  p_po_id       uuid,
  p_business_id uuid,
  p_supplier_id uuid DEFAULT NULL  -- NULL = "Marché"
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_supplier_id uuid;
  v_new_supplier_id uuid;
BEGIN
  IF get_role(p_business_id) IS NULL OR get_role(p_business_id) NOT IN ('administrateur', 'manager') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  SELECT supplier_id INTO v_old_supplier_id FROM purchase_orders
    WHERE id = p_po_id AND business_id = p_business_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Livraison introuvable' USING ERRCODE = 'P0001';
  END IF;

  v_new_supplier_id := resolve_reception_supplier(p_business_id, p_supplier_id);
  IF v_new_supplier_id = v_old_supplier_id THEN
    RETURN;
  END IF;

  UPDATE purchase_orders SET supplier_id = v_new_supplier_id
    WHERE id = p_po_id;

  UPDATE products SET supplier_id = v_new_supplier_id
    WHERE supplier_id = v_old_supplier_id
      AND id IN (SELECT product_id FROM po_lines WHERE po_id = p_po_id);
END;
$$;
