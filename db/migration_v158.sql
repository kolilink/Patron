-- ============================================================
-- Patron — Migration v158
-- Run in Supabase SQL Editor AFTER migration_v157
--
-- Adds a real reversal path for a purchase-order delivery receipt,
-- closing the second gap flagged in CLAUDE.md's "SaveConfirmation"
-- section: receive_purchase_order had no reversal RPC at all.
--
-- Why this needs a new log table, not just "subtract recv_qty back":
-- receive_purchase_order folds each receipt into products/product_
-- variants' AVCO cost_price (a weighted average with prior stock) —
-- that mutation isn't invertible from the post-receipt state alone.
-- Reversing it correctly requires knowing exactly what was added:
-- the landed cost per unit at receipt time. po_receipt_batches /
-- po_receipt_batch_lines record precisely that, once, at receipt
-- time, so void_purchase_order_receipt can algebraically subtract
-- the same landed cost back out rather than guessing at a "previous"
-- value nothing currently stores.
--
-- 1. po_receipt_batches — one row per receive_purchase_order() call
--    (its `id` is now that RPC's return value, replacing the old
--    RETURNS void). Carries the linked shipping expense id (if any)
--    and the void audit columns.
-- 2. po_receipt_batch_lines — one row per product/variant actually
--    received in that call: qty + landed_cost_cents, everything
--    void_purchase_order_receipt needs to invert the AVCO math.
-- 3. receive_purchase_order() rewritten to open a batch and log a
--    line per product/variant it touches, then RETURN the batch id
--    instead of void. Financial/stock logic is otherwise UNCHANGED
--    from migration_v101.sql.
-- 4. void_purchase_order_receipt(p_batch_id, p_business_id, p_reason):
--    - Refuses (raises, does not corrupt data) if a product/variant's
--      current stock is below what this receipt added — that stock
--      has already been sold since, and there is no safe way to
--      "un-arrive" cost/qty out from under a completed sale. This is
--      a deliberate safety refusal, not a partial-void: either the
--      whole batch reverses cleanly or none of it does.
--    - Where safe: subtracts qty back off stock, inverts the AVCO
--      weighted average using the logged landed_cost_cents, inserts
--      a compensating 'sortie' stock_move (ref_type =
--      'annulation_reception', auditable in stock_moves same as any
--      other move), decrements po_lines.qty_received, reopens the PO
--      to 'envoye' or 'recu_partiel' depending on what remains.
--    - Voids the linked shipping expense by flipping its status to
--      'rejete' (an existing, legitimate expenses.status value —
--      every cash/profit query in this codebase already filters to
--      status='approuve', so this removes it from those totals
--      without deleting or mutating the row's amount/description;
--      same non-destructive posture as everything else here).
--    - Idempotent: a batch with voided_at already set raises a clear
--      error instead of double-reversing.
--    - Admin/manager-only, same gate as receive_purchase_order.
--
-- Client-side wiring (stores/fournisseurs.ts) lands in the same
-- app-code change set as this migration — see CLAUDE.md.
-- ============================================================

-- ─── 1 & 2. Batch log tables ─────────────────────────────────

CREATE TABLE IF NOT EXISTS po_receipt_batches (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id                 uuid        NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  business_id           uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  shipping_cost_cents   bigint      NOT NULL DEFAULT 0,
  expense_id            uuid        REFERENCES expenses(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid        REFERENCES auth.users(id),
  voided_at             timestamptz,
  voided_by             uuid        REFERENCES auth.users(id),
  void_reason           text
);

CREATE TABLE IF NOT EXISTS po_receipt_batch_lines (
  id                uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id          uuid    NOT NULL REFERENCES po_receipt_batches(id) ON DELETE CASCADE,
  po_line_id        uuid    NOT NULL REFERENCES po_lines(id) ON DELETE CASCADE,
  product_id        uuid    NOT NULL,
  variant_id        uuid,
  qty_received      int     NOT NULL,
  landed_cost_cents bigint  NOT NULL
);

CREATE INDEX IF NOT EXISTS po_receipt_batches_po_id_idx ON po_receipt_batches(po_id);
CREATE INDEX IF NOT EXISTS po_receipt_batch_lines_batch_id_idx ON po_receipt_batch_lines(batch_id);

ALTER TABLE po_receipt_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE po_receipt_batch_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Membres: voir les réceptions" ON po_receipt_batches;
CREATE POLICY "Membres: voir les réceptions"
  ON po_receipt_batches FOR SELECT USING (is_member(business_id));

DROP POLICY IF EXISTS "Membres: voir les lignes de réception" ON po_receipt_batch_lines;
CREATE POLICY "Membres: voir les lignes de réception"
  ON po_receipt_batch_lines FOR SELECT USING (
    is_member((SELECT business_id FROM po_receipt_batches WHERE id = batch_id))
  );
-- No direct INSERT/UPDATE policy for either table — both are only ever
-- written by the SECURITY DEFINER functions below, same posture as
-- reconciliation_findings/reconciliation_runs.

-- ─── 3. receive_purchase_order() — logs a batch, returns its id ─

DROP FUNCTION IF EXISTS receive_purchase_order(uuid, uuid, uuid[], int[], bigint);

CREATE OR REPLACE FUNCTION receive_purchase_order(
  p_po_id               uuid,
  p_business_id         uuid,
  p_line_ids            uuid[]  DEFAULT NULL,
  p_line_qtys           int[]   DEFAULT NULL,
  p_shipping_cost_cents bigint  DEFAULT 0
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  l                  RECORD;
  recv_qty           int;
  total_lines        int;
  received_lines     int;

  total_value_cents  bigint := 0;
  line_value_cents   bigint;
  shipping_allocated bigint := 0;
  line_shipping      bigint;
  line_count         int := 0;
  current_line       int := 0;

  v_current_stock    numeric;
  v_current_cost     bigint;
  v_landed_cost      bigint;
  v_new_cost         bigint;

  v_supplier_name    text;
  v_po_date          date;
  v_expense_id       uuid;
  v_batch_id         uuid;
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

  v_batch_id := gen_random_uuid();
  INSERT INTO po_receipt_batches (id, po_id, business_id, shipping_cost_cents, created_by)
  VALUES (v_batch_id, p_po_id, p_business_id, p_shipping_cost_cents, auth.uid());

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

    total_value_cents := total_value_cents + ROUND(l.unit_cost * 100)::bigint * recv_qty;
    line_count := line_count + 1;
  END LOOP;

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

    line_value_cents := ROUND(l.unit_cost * 100)::bigint * recv_qty;

    IF p_shipping_cost_cents > 0 AND total_value_cents > 0 THEN
      IF current_line = line_count THEN
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

    v_landed_cost := ROUND(l.unit_cost * 100)::bigint
                   + CASE WHEN recv_qty > 0 THEN line_shipping / recv_qty ELSE 0 END;

    INSERT INTO stock_moves (id, business_id, product_id, type, qty, ref_id, ref_type, note, created_by)
    VALUES (
      gen_random_uuid(), p_business_id, l.product_id,
      'entree', recv_qty, p_po_id, 'purchase_order',
      'Commande reçue', auth.uid()
    );

    -- Log exactly what this line contributed, for void_purchase_order_receipt.
    INSERT INTO po_receipt_batch_lines (batch_id, po_line_id, product_id, variant_id, qty_received, landed_cost_cents)
    VALUES (v_batch_id, l.id, l.product_id, l.variant_id, recv_qty, v_landed_cost);

    IF l.variant_id IS NOT NULL THEN
      SELECT stock_qty, cost_price INTO v_current_stock, v_current_cost
        FROM product_variants WHERE id = l.variant_id;

      v_new_cost := CASE
        WHEN v_current_stock > 0 THEN
          ROUND((v_current_stock * v_current_cost + recv_qty * v_landed_cost)
                / (v_current_stock + recv_qty))::bigint
        ELSE v_landed_cost
      END;

      UPDATE product_variants
         SET stock_qty  = stock_qty + recv_qty,
             cost_price = v_new_cost
       WHERE id = l.variant_id;

      UPDATE products SET stock_qty = stock_qty + recv_qty
       WHERE id = l.product_id AND business_id = p_business_id;
    ELSE
      SELECT stock_qty, cost_price INTO v_current_stock, v_current_cost
        FROM products WHERE id = l.product_id AND business_id = p_business_id;

      v_new_cost := CASE
        WHEN v_current_stock > 0 THEN
          ROUND((v_current_stock * v_current_cost + recv_qty * v_landed_cost)
                / (v_current_stock + recv_qty))::bigint
        ELSE v_landed_cost
      END;

      UPDATE products
         SET stock_qty  = stock_qty + recv_qty,
             cost_price = v_new_cost
       WHERE id = l.product_id AND business_id = p_business_id;
    END IF;

    UPDATE po_lines SET qty_received = qty_received + recv_qty WHERE id = l.id;
  END LOOP;

  IF p_shipping_cost_cents > 0 THEN
    SELECT s.name, po.ordered_at::date
      INTO v_supplier_name, v_po_date
      FROM purchase_orders po
      LEFT JOIN suppliers s ON s.id = po.supplier_id
     WHERE po.id = p_po_id;

    INSERT INTO expenses (
      id, business_id, amount, description, category,
      date, status, created_by, approved_by, approved_at, purchase_order_id
    ) VALUES (
      gen_random_uuid(),
      p_business_id,
      p_shipping_cost_cents,
      'Frais de transport — ' || COALESCE(v_supplier_name, 'commande') || ' (' || v_po_date::text || ')',
      'transport_achat',
      CURRENT_DATE,
      'approuve',
      auth.uid(),
      auth.uid(),
      now(),
      p_po_id
    )
    RETURNING id INTO v_expense_id;

    UPDATE po_receipt_batches SET expense_id = v_expense_id WHERE id = v_batch_id;
  END IF;

  SELECT COUNT(*) INTO total_lines    FROM po_lines WHERE po_id = p_po_id;
  SELECT COUNT(*) INTO received_lines FROM po_lines WHERE po_id = p_po_id AND qty_received >= qty_ordered;

  UPDATE purchase_orders
     SET status      = CASE WHEN received_lines = total_lines THEN 'recu' ELSE 'recu_partiel' END,
         received_at = CASE WHEN received_lines = total_lines THEN now() ELSE received_at END
   WHERE id = p_po_id;

  RETURN v_batch_id;
END;
$$;

GRANT EXECUTE ON FUNCTION receive_purchase_order(uuid, uuid, uuid[], int[], bigint) TO authenticated;

-- ─── 4. void_purchase_order_receipt() — the actual reversal ────

CREATE OR REPLACE FUNCTION void_purchase_order_receipt(
  p_batch_id    uuid,
  p_business_id uuid,
  p_reason      text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_batch          record;
  bl               record;
  v_current_stock  numeric;
  v_current_cost   bigint;
  v_new_stock      numeric;
  v_new_cost       bigint;
  total_lines      int;
  received_lines   int;
BEGIN
  IF get_role(p_business_id) NOT IN ('administrateur', 'manager') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_batch
  FROM po_receipt_batches
  WHERE id = p_batch_id AND business_id = p_business_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Réception introuvable' USING ERRCODE = 'P0001';
  END IF;

  IF v_batch.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cette réception a déjà été annulée' USING ERRCODE = 'P0001';
  END IF;

  -- Safety pre-check first, whole batch: refuse cleanly rather than
  -- partially reversing if any line's stock has already been sold down
  -- below what this receipt added.
  FOR bl IN SELECT * FROM po_receipt_batch_lines WHERE batch_id = p_batch_id LOOP
    IF bl.variant_id IS NOT NULL THEN
      SELECT stock_qty INTO v_current_stock FROM product_variants WHERE id = bl.variant_id FOR UPDATE;
    ELSE
      SELECT stock_qty INTO v_current_stock FROM products WHERE id = bl.product_id AND business_id = p_business_id FOR UPDATE;
    END IF;
    IF v_current_stock IS NULL OR v_current_stock < bl.qty_received THEN
      RAISE EXCEPTION 'Stock déjà vendu depuis cette réception — annulation impossible' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  FOR bl IN SELECT * FROM po_receipt_batch_lines WHERE batch_id = p_batch_id LOOP
    IF bl.variant_id IS NOT NULL THEN
      SELECT stock_qty, cost_price INTO v_current_stock, v_current_cost
        FROM product_variants WHERE id = bl.variant_id;

      v_new_stock := v_current_stock - bl.qty_received;
      v_new_cost := CASE
        WHEN v_new_stock > 0 THEN
          GREATEST(0, ROUND((v_current_stock * v_current_cost - bl.qty_received * bl.landed_cost_cents) / v_new_stock))::bigint
        ELSE v_current_cost
      END;

      UPDATE product_variants SET stock_qty = v_new_stock, cost_price = v_new_cost WHERE id = bl.variant_id;
      UPDATE products SET stock_qty = stock_qty - bl.qty_received WHERE id = bl.product_id AND business_id = p_business_id;
    ELSE
      SELECT stock_qty, cost_price INTO v_current_stock, v_current_cost
        FROM products WHERE id = bl.product_id AND business_id = p_business_id;

      v_new_stock := v_current_stock - bl.qty_received;
      v_new_cost := CASE
        WHEN v_new_stock > 0 THEN
          GREATEST(0, ROUND((v_current_stock * v_current_cost - bl.qty_received * bl.landed_cost_cents) / v_new_stock))::bigint
        ELSE v_current_cost
      END;

      UPDATE products SET stock_qty = v_new_stock, cost_price = v_new_cost
       WHERE id = bl.product_id AND business_id = p_business_id;
    END IF;

    INSERT INTO stock_moves (id, business_id, product_id, type, qty, ref_id, ref_type, note, created_by)
    VALUES (
      gen_random_uuid(), p_business_id, bl.product_id,
      'sortie', bl.qty_received, v_batch.po_id, 'annulation_reception',
      COALESCE(p_reason, 'Annulation de réception'), auth.uid()
    );

    UPDATE po_lines SET qty_received = GREATEST(0, qty_received - bl.qty_received) WHERE id = bl.po_line_id;
  END LOOP;

  -- Void the linked shipping expense (status flip, never a delete/amount edit —
  -- every cash/profit query in this codebase already filters to status='approuve').
  IF v_batch.expense_id IS NOT NULL THEN
    UPDATE expenses
       SET status = 'rejete'
     WHERE id = v_batch.expense_id AND status = 'approuve';
  END IF;

  UPDATE po_receipt_batches
     SET voided_at = now(), voided_by = auth.uid(), void_reason = p_reason
   WHERE id = p_batch_id;

  -- Reopen the PO to reflect what's actually still received.
  SELECT COUNT(*) INTO total_lines    FROM po_lines WHERE po_id = v_batch.po_id;
  SELECT COUNT(*) INTO received_lines FROM po_lines WHERE po_id = v_batch.po_id AND qty_received >= qty_ordered;

  UPDATE purchase_orders
     SET status = CASE
                     WHEN received_lines = total_lines AND total_lines > 0 THEN 'recu'
                     WHEN EXISTS (SELECT 1 FROM po_lines WHERE po_id = v_batch.po_id AND qty_received > 0) THEN 'recu_partiel'
                     ELSE 'envoye'
                   END,
         received_at = CASE WHEN received_lines = total_lines AND total_lines > 0 THEN received_at ELSE NULL END
   WHERE id = v_batch.po_id;
END;
$$;

GRANT EXECUTE ON FUNCTION void_purchase_order_receipt(uuid, uuid, text) TO authenticated;
