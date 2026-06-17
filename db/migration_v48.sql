-- ============================================================
-- Patron — Migration v48
-- Run in Supabase SQL Editor AFTER migration_v47
--
-- When a purchase order is received, auto-update each product's
-- cost_price to the PO unit cost so the product edit form
-- pre-fills with the latest purchase cost.
--
-- po_lines.unit_cost is stored in display units (e.g. 1000 GNF).
-- products.cost_price is BIGINT ×100 (e.g. 100000 for 1000 GNF).
-- ============================================================

CREATE OR REPLACE FUNCTION receive_purchase_order(
  p_po_id       uuid,
  p_business_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  l RECORD;
BEGIN
  -- Role check: only admin/manager can receive purchase orders
  IF get_role(p_business_id) NOT IN ('administrateur', 'manager') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  -- Verify ownership and guard against double-receive
  IF NOT EXISTS (
    SELECT 1 FROM purchase_orders
    WHERE id = p_po_id
      AND business_id = p_business_id
      AND status != 'recu'
  ) THEN
    RAISE EXCEPTION 'Commande introuvable ou déjà reçue';
  END IF;

  -- Mark received
  UPDATE purchase_orders
  SET status = 'recu', received_at = now()
  WHERE id = p_po_id;

  -- Process each line atomically
  FOR l IN SELECT * FROM po_lines WHERE po_id = p_po_id LOOP
    INSERT INTO stock_moves (id, business_id, product_id, type, qty, ref_id, ref_type, note, created_by)
    VALUES (
      gen_random_uuid(), p_business_id, l.product_id,
      'entree', l.qty_ordered, p_po_id, 'purchase_order',
      'Commande reçue', auth.uid()
    );

    UPDATE products
    SET
      stock_qty  = stock_qty + l.qty_ordered,
      cost_price = ROUND(l.unit_cost * 100)::bigint
    WHERE id = l.product_id AND business_id = p_business_id;

    UPDATE po_lines SET qty_received = qty_ordered WHERE id = l.id;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION receive_purchase_order(uuid, uuid) TO authenticated;
