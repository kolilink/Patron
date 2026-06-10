-- ============================================================
-- Patron — Migration v45
-- Fixes H5: receive_purchase_order missing role check and
-- caller-supplied audit trail.
-- Previously: no role check (any member could mark orders
-- received), and p_user_id was caller-supplied (audit trail
-- could be forged with any user UUID).
-- Fix: add admin/manager role gate, use auth.uid() internally.
-- ============================================================

CREATE OR REPLACE FUNCTION receive_purchase_order(
  p_po_id       uuid,
  p_business_id uuid
  -- p_user_id removed: use auth.uid() to prevent audit trail forgery
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

  -- Process each line atomically inside the same transaction
  FOR l IN SELECT * FROM po_lines WHERE po_id = p_po_id LOOP
    INSERT INTO stock_moves (id, business_id, product_id, type, qty, ref_id, ref_type, note, created_by)
    VALUES (
      gen_random_uuid(), p_business_id, l.product_id,
      'entree', l.qty_ordered, p_po_id, 'purchase_order',
      'Commande reçue', auth.uid()   -- auth.uid() instead of caller-supplied p_user_id
    );

    UPDATE products
    SET stock_qty = stock_qty + l.qty_ordered
    WHERE id = l.product_id AND business_id = p_business_id;

    UPDATE po_lines SET qty_received = qty_ordered WHERE id = l.id;
  END LOOP;
END;
$$;

-- Revoke old 3-arg grant (with p_user_id), grant the new 2-arg signature
REVOKE EXECUTE ON FUNCTION receive_purchase_order(uuid, uuid, uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION receive_purchase_order(uuid, uuid)       TO authenticated;
