-- ============================================================
-- Patron — Migration v49
-- Run in Supabase SQL Editor AFTER migration_v48
--
-- Adds partial receipt support to receive_purchase_order.
-- p_line_ids = NULL → receive all unreceived lines (original behavior).
-- p_line_ids = [uuid, ...] → receive only those specific lines.
-- PO status becomes 'recu_partiel' if any lines remain unreceived,
-- 'recu' when all lines are fully received.
-- ============================================================

CREATE OR REPLACE FUNCTION receive_purchase_order(
  p_po_id       uuid,
  p_business_id uuid,
  p_line_ids    uuid[] DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  l              RECORD;
  total_lines    int;
  received_lines int;
BEGIN
  -- Role check
  IF get_role(p_business_id) NOT IN ('administrateur', 'manager') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  -- Verify PO exists and hasn't been fully received yet
  IF NOT EXISTS (
    SELECT 1 FROM purchase_orders
    WHERE id = p_po_id
      AND business_id = p_business_id
      AND status NOT IN ('recu', 'annule')
  ) THEN
    RAISE EXCEPTION 'Commande introuvable ou déjà reçue';
  END IF;

  -- Process the selected lines (or all unreceived lines if p_line_ids is NULL)
  FOR l IN
    SELECT * FROM po_lines
    WHERE po_id = p_po_id
      AND qty_received < qty_ordered
      AND (p_line_ids IS NULL OR id = ANY(p_line_ids))
  LOOP
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

  -- Determine new PO status
  SELECT COUNT(*) INTO total_lines    FROM po_lines WHERE po_id = p_po_id;
  SELECT COUNT(*) INTO received_lines FROM po_lines WHERE po_id = p_po_id AND qty_received >= qty_ordered;

  UPDATE purchase_orders
  SET
    status      = CASE WHEN received_lines = total_lines THEN 'recu' ELSE 'recu_partiel' END,
    received_at = CASE WHEN received_lines = total_lines THEN now() ELSE received_at END
  WHERE id = p_po_id;
END;
$$;

GRANT EXECUTE ON FUNCTION receive_purchase_order(uuid, uuid, uuid[]) TO authenticated;
