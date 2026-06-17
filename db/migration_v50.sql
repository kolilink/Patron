-- ============================================================
-- Patron — Migration v50
-- Run in Supabase SQL Editor AFTER migration_v49
--
-- Extends receive_purchase_order to accept per-line received
-- quantities (parallel arrays p_line_ids / p_line_qtys).
-- NULL for both = receive all remaining qty (original behavior).
-- qty_received is now additive so multiple partial receipts work.
-- ============================================================

-- Drop previous signature (v49 added uuid[] param)
DROP FUNCTION IF EXISTS receive_purchase_order(uuid, uuid, uuid[]);

CREATE OR REPLACE FUNCTION receive_purchase_order(
  p_po_id       uuid,
  p_business_id uuid,
  p_line_ids    uuid[] DEFAULT NULL,
  p_line_qtys   int[]  DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  l              RECORD;
  recv_qty       int;
  total_lines    int;
  received_lines int;
BEGIN
  IF get_role(p_business_id) NOT IN ('administrateur', 'manager') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM purchase_orders
    WHERE id = p_po_id AND business_id = p_business_id
      AND status NOT IN ('recu', 'annule')
  ) THEN
    RAISE EXCEPTION 'Commande introuvable ou déjà reçue';
  END IF;

  FOR l IN
    SELECT * FROM po_lines
    WHERE po_id = p_po_id
      AND qty_received < qty_ordered
      AND (p_line_ids IS NULL OR id = ANY(p_line_ids))
  LOOP
    -- Determine how many to receive for this line
    IF p_line_qtys IS NOT NULL THEN
      recv_qty := p_line_qtys[array_position(p_line_ids, l.id)];
    ELSE
      recv_qty := l.qty_ordered - l.qty_received;
    END IF;

    IF recv_qty IS NULL OR recv_qty <= 0 THEN CONTINUE; END IF;

    -- Cap at what's still outstanding
    recv_qty := LEAST(recv_qty, l.qty_ordered - l.qty_received);

    INSERT INTO stock_moves (id, business_id, product_id, type, qty, ref_id, ref_type, note, created_by)
    VALUES (
      gen_random_uuid(), p_business_id, l.product_id,
      'entree', recv_qty, p_po_id, 'purchase_order',
      'Commande reçue', auth.uid()
    );

    UPDATE products
    SET
      stock_qty  = stock_qty + recv_qty,
      cost_price = ROUND(l.unit_cost * 100)::bigint
    WHERE id = l.product_id AND business_id = p_business_id;

    -- Additive: accumulate across multiple partial receipts
    UPDATE po_lines
    SET qty_received = qty_received + recv_qty
    WHERE id = l.id;
  END LOOP;

  -- Determine final PO status
  SELECT COUNT(*) INTO total_lines    FROM po_lines WHERE po_id = p_po_id;
  SELECT COUNT(*) INTO received_lines FROM po_lines WHERE po_id = p_po_id AND qty_received >= qty_ordered;

  UPDATE purchase_orders
  SET
    status      = CASE WHEN received_lines = total_lines THEN 'recu' ELSE 'recu_partiel' END,
    received_at = CASE WHEN received_lines = total_lines THEN now() ELSE received_at END
  WHERE id = p_po_id;
END;
$$;

GRANT EXECUTE ON FUNCTION receive_purchase_order(uuid, uuid, uuid[], int[]) TO authenticated;
