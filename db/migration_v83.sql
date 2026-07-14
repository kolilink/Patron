-- ============================================================
-- Patron — Migration v83
-- Run in Supabase SQL Editor AFTER migration_v82
--
-- Two changes to receive_purchase_order:
--   1. Accept p_shipping_cost_cents (total shipping for the whole
--      delivery). Allocated across received lines proportionally
--      by line value (unit_cost × qty_received). The last line
--      absorbs any rounding remainder so the total is exact.
--   2. Replace "last cost wins" with AVCO (weighted average cost).
--      For variant lines: updates product_variants.cost_price.
--      For plain product lines: updates products.cost_price.
--      Both use the formula:
--        new_cost = ROUND(
--          (current_stock × current_cost + recv_qty × landed_unit_cost)
--          / (current_stock + recv_qty)
--        )
--      If current_stock <= 0, the landed unit cost replaces outright.
-- ============================================================

DROP FUNCTION IF EXISTS receive_purchase_order(uuid, uuid, uuid[], int[]);

CREATE OR REPLACE FUNCTION receive_purchase_order(
  p_po_id              uuid,
  p_business_id        uuid,
  p_line_ids           uuid[]  DEFAULT NULL,
  p_line_qtys          int[]   DEFAULT NULL,
  p_shipping_cost_cents bigint DEFAULT 0
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  l                 RECORD;
  recv_qty          int;
  total_lines       int;
  received_lines    int;

  -- Shipping allocation
  total_value_cents bigint := 0;
  line_value_cents  bigint;
  shipping_allocated bigint := 0;
  line_shipping     bigint;
  line_count        int := 0;
  current_line      int := 0;

  -- AVCO
  v_current_stock   numeric;
  v_current_cost    bigint;
  v_landed_cost     bigint;
  v_new_cost        bigint;
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

  -- ── Pre-pass: compute total value of lines being received ────────────────
  -- Needed to allocate shipping proportionally by value.
  FOR l IN
    SELECT * FROM po_lines
    WHERE po_id = p_po_id
      AND qty_received < qty_ordered
      AND (p_line_ids IS NULL OR id = ANY(p_line_ids))
  LOOP
    IF p_line_qtys IS NOT NULL THEN
      recv_qty := p_line_qtys[array_position(p_line_ids, l.id)];
    ELSE
      recv_qty := l.qty_ordered - l.qty_received;
    END IF;
    IF recv_qty IS NULL OR recv_qty <= 0 THEN CONTINUE; END IF;
    recv_qty := LEAST(recv_qty, l.qty_ordered - l.qty_received);

    total_value_cents := total_value_cents
      + ROUND(l.unit_cost * 100)::bigint * recv_qty;
    line_count := line_count + 1;
  END LOOP;

  -- ── Main loop ─────────────────────────────────────────────────────────────
  FOR l IN
    SELECT * FROM po_lines
    WHERE po_id = p_po_id
      AND qty_received < qty_ordered
      AND (p_line_ids IS NULL OR id = ANY(p_line_ids))
  LOOP
    IF p_line_qtys IS NOT NULL THEN
      recv_qty := p_line_qtys[array_position(p_line_ids, l.id)];
    ELSE
      recv_qty := l.qty_ordered - l.qty_received;
    END IF;
    IF recv_qty IS NULL OR recv_qty <= 0 THEN CONTINUE; END IF;
    recv_qty := LEAST(recv_qty, l.qty_ordered - l.qty_received);

    current_line := current_line + 1;

    -- ── Shipping allocation by value ──────────────────────────────────────
    line_value_cents := ROUND(l.unit_cost * 100)::bigint * recv_qty;

    IF p_shipping_cost_cents > 0 AND total_value_cents > 0 THEN
      IF current_line = line_count THEN
        -- Last line absorbs rounding remainder
        line_shipping := p_shipping_cost_cents - shipping_allocated;
      ELSE
        line_shipping := ROUND(
          p_shipping_cost_cents::numeric * line_value_cents / total_value_cents
        )::bigint;
      END IF;
      shipping_allocated := shipping_allocated + line_shipping;
    ELSE
      line_shipping := 0;
    END IF;

    -- Landed unit cost in cents
    v_landed_cost := ROUND(l.unit_cost * 100)::bigint
                   + CASE WHEN recv_qty > 0 THEN line_shipping / recv_qty ELSE 0 END;

    -- ── Stock move ────────────────────────────────────────────────────────
    INSERT INTO stock_moves (id, business_id, product_id, type, qty, ref_id, ref_type, note, created_by)
    VALUES (
      gen_random_uuid(), p_business_id, l.product_id,
      'entree', recv_qty, p_po_id, 'purchase_order',
      'Commande reçue', auth.uid()
    );

    -- ── AVCO cost update ──────────────────────────────────────────────────
    IF l.variant_id IS NOT NULL THEN
      -- Variant product: update product_variants.cost_price
      SELECT stock_qty, cost_price
        INTO v_current_stock, v_current_cost
        FROM product_variants
       WHERE id = l.variant_id;

      IF v_current_stock > 0 THEN
        v_new_cost := ROUND(
          (v_current_stock * v_current_cost + recv_qty * v_landed_cost)
          / (v_current_stock + recv_qty)
        )::bigint;
      ELSE
        v_new_cost := v_landed_cost;
      END IF;

      UPDATE product_variants
         SET stock_qty  = stock_qty + recv_qty,
             cost_price = v_new_cost
       WHERE id = l.variant_id;

      -- Increment parent stock_qty only (parent cost_price not used for variants)
      UPDATE products
         SET stock_qty = stock_qty + recv_qty
       WHERE id = l.product_id AND business_id = p_business_id;

    ELSE
      -- Plain product: update products.cost_price
      SELECT stock_qty, cost_price
        INTO v_current_stock, v_current_cost
        FROM products
       WHERE id = l.product_id AND business_id = p_business_id;

      IF v_current_stock > 0 THEN
        v_new_cost := ROUND(
          (v_current_stock * v_current_cost + recv_qty * v_landed_cost)
          / (v_current_stock + recv_qty)
        )::bigint;
      ELSE
        v_new_cost := v_landed_cost;
      END IF;

      UPDATE products
         SET stock_qty  = stock_qty + recv_qty,
             cost_price = v_new_cost
       WHERE id = l.product_id AND business_id = p_business_id;
    END IF;

    UPDATE po_lines
       SET qty_received = qty_received + recv_qty
     WHERE id = l.id;
  END LOOP;

  -- ── Final PO status ───────────────────────────────────────────────────────
  SELECT COUNT(*) INTO total_lines    FROM po_lines WHERE po_id = p_po_id;
  SELECT COUNT(*) INTO received_lines FROM po_lines WHERE po_id = p_po_id AND qty_received >= qty_ordered;

  UPDATE purchase_orders
     SET status      = CASE WHEN received_lines = total_lines THEN 'recu' ELSE 'recu_partiel' END,
         received_at = CASE WHEN received_lines = total_lines THEN now() ELSE received_at END
   WHERE id = p_po_id;
END;
$$;

GRANT EXECUTE ON FUNCTION receive_purchase_order(uuid, uuid, uuid[], int[], bigint) TO authenticated;
