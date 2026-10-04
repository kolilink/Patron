-- ============================================================
-- Patron — Migration v221
-- Run in Supabase SQL Editor AFTER migration_v220
--
-- SWEEP FIX — Phase 1.3: "Prix inconnu" for a received item.
--
-- Problem
-- -------
-- fournisseurs/reception.tsx forced a purchase cost on every line
-- (firstIssue() returned 'price' for a blank/zero cost), so a merchant
-- who genuinely doesn't know what an item cost could only lie. The
-- client sent unit_cost_cents = 0, and confirm_reception() / receive_
-- purchase_order() folded that 0 into the product's AVCO cost_price —
-- a "0 cost" that is silently wrong (0 = "free", not "unknown").
-- Profit then treated that 0-cost line as real, and submit_sale's
-- cost snapshot never recorded NULL (unknown), so get_period_report
-- (v220) had no way to exclude it.
--
-- Fix
-- ---
-- 1. Drop NOT NULL on the four cost columns so NULL can honestly mean
--    "unknown": products.cost_price, product_variants.cost_price,
--    po_lines.unit_cost, po_receipt_batch_lines.landed_cost_cents.
-- 2. confirm_reception() (v218 superset): a blank/absent unit_cost_cents
--    now maps to NULL v_unit_cost → NULL po_lines.unit_cost and NULL
--    products.cost_price; total_cost only sums known costs.
-- 3. receive_purchase_order() (v218 superset): a NULL po_lines.unit_cost
--    logs NULL landed_cost_cents and leaves the product/variant's existing
--    cost_price untouched (stock still increments). Known-cost lines keep
--    the exact AVCO math.
-- 4. void_purchase_order_receipt() (v158 superset): a NULL logged
--    landed_cost_cents skips the AVCO cost inversion (stock still
--    decrements, cost stays as-is).
--
-- submit_sale (v217) already snapshots a NULL product cost into
-- so_lines.cost_price_at_sale, and get_period_report (v220) already
-- excludes unknown-cost revenue from profit — so this migration is the
-- final link that lets an honest "Prix inconnu" flow end-to-end.
-- ============================================================

-- ─── 1. Allow NULL to mean "unknown cost" ──────────────────────────────────

ALTER TABLE products
  ALTER COLUMN cost_price DROP NOT NULL;

ALTER TABLE product_variants
  ALTER COLUMN cost_price DROP NOT NULL;

ALTER TABLE po_lines
  ALTER COLUMN unit_cost DROP NOT NULL;

ALTER TABLE po_receipt_batch_lines
  ALTER COLUMN landed_cost_cents DROP NOT NULL;

-- ─── 2. confirm_reception() — blank cost → NULL, not 0 ─────────────────────
-- Superset of the v218 body (business scoping + received_date + ownership
-- validation all preserved). Only the cost handling changes: a missing or
-- blank unit_cost_cents becomes NULL v_unit_cost, which propagates as NULL
-- po_lines.unit_cost and NULL products.cost_price, and total_cost sums only
-- known-cost lines.

DROP FUNCTION IF EXISTS public.confirm_reception(uuid, uuid, uuid, jsonb, bigint, numeric);

CREATE OR REPLACE FUNCTION public.confirm_reception(
  p_business_id          uuid,
  p_supplier_id          uuid    DEFAULT NULL,  -- NULL = "Marché"
  p_po_id                uuid    DEFAULT NULL,  -- Porte 2: existing order being confirmed
  p_lines                jsonb   DEFAULT '[]',
  p_transport_cost_cents bigint  DEFAULT 0,
  p_margin_percent       numeric DEFAULT NULL,
  p_received_date        date    DEFAULT NULL    -- optional real/backdated delivery date
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_supplier_id uuid;
  v_po_id       uuid;
  v_item        jsonb;
  v_product_id  uuid;
  v_variant_id  uuid;
  v_qty         numeric;
  v_unit_cost   numeric;
  v_total_cost  numeric := 0;
BEGIN
  IF get_role(p_business_id) IS NULL OR get_role(p_business_id) NOT IN ('administrateur', 'manager') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF p_lines IS NULL OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Ajoutez au moins un article' USING ERRCODE = 'P0001';
  END IF;

  v_supplier_id := resolve_reception_supplier(p_business_id, p_supplier_id);

  IF p_po_id IS NOT NULL THEN
    SELECT id INTO v_po_id FROM purchase_orders
      WHERE id = p_po_id AND business_id = p_business_id AND status NOT IN ('recu', 'annule');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Commande introuvable ou déjà terminée' USING ERRCODE = 'P0001';
    END IF;
    DELETE FROM po_lines WHERE po_id = v_po_id;
  ELSE
    INSERT INTO purchase_orders (business_id, supplier_id, status, created_by)
    VALUES (p_business_id, v_supplier_id, 'brouillon', auth.uid())
    RETURNING id INTO v_po_id;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_product_id := nullif(v_item->>'product_id', '')::uuid;
    v_variant_id := nullif(v_item->>'variant_id', '')::uuid;
    v_qty        := (v_item->>'qty')::numeric;

    -- v221: a blank/absent unit_cost_cents is "Prix inconnu" — NULL, not 0.
    -- An explicit 0 is treated as unknown too (a free item is indistinguishable
    -- from an unrecorded one, and the old UI blocked 0 outright).
    v_unit_cost := nullif((v_item->>'unit_cost_cents')::numeric, 0);
    IF v_unit_cost IS NOT NULL THEN
      v_unit_cost := v_unit_cost / 100.0;
    END IF;

    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'Quantité invalide pour "%"', coalesce(v_item->>'name', 'un article') USING ERRCODE = 'P0001';
    END IF;

    IF v_product_id IS NULL THEN
      INSERT INTO products (business_id, name, supplier_id, cost_price, sale_price, created_by)
      VALUES (
        p_business_id,
        v_item->>'name',
        v_supplier_id,
        CASE WHEN v_unit_cost IS NULL THEN NULL ELSE round(v_unit_cost * 100)::bigint END,
        coalesce((v_item->>'sale_price_cents')::bigint, 0),
        auth.uid()
      )
      RETURNING id INTO v_product_id;
    ELSE
      -- Existing product/variant referenced by id — must belong to this
      -- business (migration_v196 ownership validation, kept here so the
      -- numeric replay doesn't reopen the cross-business write bug).
      IF NOT EXISTS (
        SELECT 1 FROM products WHERE id = v_product_id AND business_id = p_business_id
      ) THEN
        RAISE EXCEPTION 'Produit introuvable' USING ERRCODE = 'P0001';
      END IF;

      IF v_variant_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM product_variants WHERE id = v_variant_id AND business_id = p_business_id
      ) THEN
        RAISE EXCEPTION 'Produit introuvable' USING ERRCODE = 'P0001';
      END IF;

      IF v_variant_id IS NULL AND nullif(v_item->>'sale_price_cents', '') IS NOT NULL THEN
        UPDATE products SET sale_price = (v_item->>'sale_price_cents')::bigint
          WHERE id = v_product_id AND business_id = p_business_id;
      END IF;
    END IF;

    INSERT INTO po_lines (po_id, product_id, variant_id, qty_ordered, qty_received, unit_cost)
    VALUES (v_po_id, v_product_id, v_variant_id, v_qty, 0, v_unit_cost);

    -- v221: only known-cost lines contribute to the order total.
    IF v_unit_cost IS NOT NULL THEN
      v_total_cost := v_total_cost + v_qty * v_unit_cost;
    END IF;
  END LOOP;

  UPDATE purchase_orders SET total_cost = v_total_cost WHERE id = v_po_id;

  PERFORM receive_purchase_order(v_po_id, p_business_id, NULL, NULL, p_transport_cost_cents);

  -- Real/backdated delivery date: once the receive has run (which stamps
  -- received_at = now()), override the order's dates with the merchant's
  -- actual date so history reads correctly.
  IF p_received_date IS NOT NULL THEN
    UPDATE purchase_orders
       SET ordered_at  = p_received_date::timestamptz,
           received_at = p_received_date::timestamptz
     WHERE id = v_po_id;
  END IF;

  RETURN v_po_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.confirm_reception(uuid, uuid, uuid, jsonb, bigint, numeric, date) TO authenticated;

-- ─── 3. receive_purchase_order() — NULL cost logs NULL, keeps old cost ─────
-- Superset of the v218 body (variant_id stamping + business scoping + the
-- get_role() IS NULL guard from v196). Unknown-cost lines still increment
-- stock and log a batch line, but landed_cost_cents is NULL and the product
-- /variant's existing cost_price is left untouched.

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
  IF get_role(p_business_id) IS NULL OR get_role(p_business_id) NOT IN ('administrateur', 'manager') THEN
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

    -- v221: unknown-cost lines don't contribute to the shipping base.
    IF l.unit_cost IS NOT NULL THEN
      total_value_cents := total_value_cents + ROUND(l.unit_cost * 100)::bigint * recv_qty;
    END IF;
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

    line_value_cents := CASE WHEN l.unit_cost IS NULL THEN 0
                             ELSE ROUND(l.unit_cost * 100)::bigint * recv_qty END;

    IF l.unit_cost IS NOT NULL AND p_shipping_cost_cents > 0 AND total_value_cents > 0 THEN
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

    -- v221: unknown cost → NULL landed cost (nothing to fold into AVCO).
    v_landed_cost := CASE
      WHEN l.unit_cost IS NULL THEN NULL
      ELSE ROUND(l.unit_cost * 100)::bigint
         + CASE WHEN recv_qty > 0 THEN line_shipping / recv_qty ELSE 0 END
    END;

    INSERT INTO stock_moves (id, business_id, product_id, variant_id, type, qty, ref_id, ref_type, note, created_by)
    VALUES (
      gen_random_uuid(), p_business_id, l.product_id, l.variant_id,
      'entree', recv_qty, p_po_id, 'purchase_order',
      'Commande reçue', auth.uid()
    );

    -- Log exactly what this line contributed, for void_purchase_order_receipt.
    -- landed_cost_cents is NULL when the cost was unknown.
    INSERT INTO po_receipt_batch_lines (batch_id, po_line_id, product_id, variant_id, qty_received, landed_cost_cents)
    VALUES (v_batch_id, l.id, l.product_id, l.variant_id, recv_qty, v_landed_cost);

    IF l.variant_id IS NOT NULL THEN
      SELECT stock_qty, cost_price INTO v_current_stock, v_current_cost
        FROM product_variants WHERE id = l.variant_id AND business_id = p_business_id;

      -- v221: keep the existing cost when this line's cost is unknown, adopt
      -- the new landed cost when there was no prior cost, otherwise AVCO.
      v_new_cost := CASE
        WHEN v_landed_cost IS NULL THEN v_current_cost
        WHEN v_current_cost IS NULL THEN v_landed_cost
        WHEN v_current_stock > 0 THEN
          ROUND((v_current_stock * v_current_cost + recv_qty * v_landed_cost)
                / (v_current_stock + recv_qty))::bigint
        ELSE v_landed_cost
      END;

      UPDATE product_variants
         SET stock_qty  = stock_qty + recv_qty,
             cost_price = v_new_cost
       WHERE id = l.variant_id AND business_id = p_business_id;

      UPDATE products SET stock_qty = stock_qty + recv_qty
       WHERE id = l.product_id AND business_id = p_business_id;
    ELSE
      SELECT stock_qty, cost_price INTO v_current_stock, v_current_cost
        FROM products WHERE id = l.product_id AND business_id = p_business_id;

      v_new_cost := CASE
        WHEN v_landed_cost IS NULL THEN v_current_cost
        WHEN v_current_cost IS NULL THEN v_landed_cost
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
      date, status, created_by, approved_by, approved_at,
      purchase_order_id
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

-- ─── 4. void_purchase_order_receipt() — skip cost inversion on NULL ────────
-- Superset of the v158 body. When a batch line's logged landed_cost_cents is
-- NULL (the cost was unknown at receipt time), the AVCO inversion is skipped:
-- stock still decrements and the compensating move is still logged, but the
-- product/variant's cost_price is left exactly as it was.

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

      -- v221: NULL landed cost means the cost was unknown — decrement stock
      -- but do not invert the AVCO cost (there is nothing to invert).
      IF bl.landed_cost_cents IS NULL THEN
        UPDATE product_variants SET stock_qty = v_new_stock WHERE id = bl.variant_id;
      ELSE
        v_new_cost := CASE
          WHEN v_new_stock > 0 THEN
            GREATEST(0, ROUND((v_current_stock * v_current_cost - bl.qty_received * bl.landed_cost_cents) / v_new_stock))::bigint
          ELSE v_current_cost
        END;
        UPDATE product_variants SET stock_qty = v_new_stock, cost_price = v_new_cost WHERE id = bl.variant_id;
      END IF;

      UPDATE products SET stock_qty = stock_qty - bl.qty_received WHERE id = bl.product_id AND business_id = p_business_id;
    ELSE
      SELECT stock_qty, cost_price INTO v_current_stock, v_current_cost
        FROM products WHERE id = bl.product_id AND business_id = p_business_id;

      v_new_stock := v_current_stock - bl.qty_received;

      IF bl.landed_cost_cents IS NULL THEN
        UPDATE products SET stock_qty = v_new_stock WHERE id = bl.product_id AND business_id = p_business_id;
      ELSE
        v_new_cost := CASE
          WHEN v_new_stock > 0 THEN
            GREATEST(0, ROUND((v_current_stock * v_current_cost - bl.qty_received * bl.landed_cost_cents) / v_new_stock))::bigint
          ELSE v_current_cost
        END;
        UPDATE products SET stock_qty = v_new_stock, cost_price = v_new_cost
         WHERE id = bl.product_id AND business_id = p_business_id;
      END IF;
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
