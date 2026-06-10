-- ============================================================
-- Patron — Migration v36
-- Run in Supabase SQL Editor AFTER migration_v35
-- Wraps purchase order receipt in a single DB transaction so
-- stock moves + stock qty increments are atomic (no partial update).
-- ============================================================

CREATE OR REPLACE FUNCTION receive_purchase_order(
  p_po_id       uuid,
  p_business_id uuid,
  p_user_id     uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  l RECORD;
BEGIN
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
      'Commande reçue', p_user_id
    );

    -- Direct increment — no read-modify-write race
    UPDATE products
    SET stock_qty = stock_qty + l.qty_ordered
    WHERE id = l.product_id AND business_id = p_business_id;

    UPDATE po_lines SET qty_received = qty_ordered WHERE id = l.id;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION receive_purchase_order(uuid, uuid, uuid) TO authenticated;
