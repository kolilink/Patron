-- ============================================================
-- E2E FIX BATCH D — catalog & carnet. TEST DB only — do not commit.
-- ============================================================
-- 1. variant re-save blocked after first sale/PO:
--    upsert_product_variants() hard-DELETEd every variant row, but
--    so_lines.variant_id / po_lines.variant_id reference
--    product_variants(id) with NO ON DELETE (migration_v65), so deleting a
--    referenced variant made the next save fail. Rewritten to archive
--    removed variants and upsert-by-name (preserving ids).
-- 2. reception has no real/backdated date: confirm_reception() created the
--    PO with default now() and receive_purchase_order() stamped
--    received_at = now(). Adds p_received_date to confirm_reception so the
--    recorded delivery can be dated for real.
-- 3. two "Rappeler" WhatsApp drafts disagreed (client-side).
-- 4. variant stock edits leave no audit trail: stock_moves had no
--    variant_id column. Added + populated everywhere variants move stock.
-- 5. low-stock push wrong for variant products (client-side + edge fn).

-- ─── 1. stock_moves.variant_id audit column ─────────────────────────────────

ALTER TABLE stock_moves
  ADD COLUMN IF NOT EXISTS variant_id uuid REFERENCES product_variants(id);

CREATE INDEX IF NOT EXISTS idx_stock_moves_variant
  ON stock_moves (variant_id);

-- ─── 2. receive_purchase_order() — stamp variant_id on its stock move ──────
-- Same signature: existing callers (incl. cross-business-po-flow tests) use
-- named args, so the parameter list must not change.

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

    INSERT INTO stock_moves (id, business_id, product_id, variant_id, type, qty, ref_id, ref_type, note, created_by)
    VALUES (
      gen_random_uuid(), p_business_id, l.product_id, l.variant_id,
      'entree', recv_qty, p_po_id, 'purchase_order',
      'Commande reçue', auth.uid()
    );

    -- Log exactly what this line contributed, for void_purchase_order_receipt.
    INSERT INTO po_receipt_batch_lines (batch_id, po_line_id, product_id, variant_id, qty_received, landed_cost_cents)
    VALUES (v_batch_id, l.id, l.product_id, l.variant_id, recv_qty, v_landed_cost);

    IF l.variant_id IS NOT NULL THEN
      SELECT stock_qty, cost_price INTO v_current_stock, v_current_cost
        FROM product_variants WHERE id = l.variant_id AND business_id = p_business_id;

      v_new_cost := CASE
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

-- ─── 3. cancel_sale() — stamp variant_id on its restock move ───────────────

CREATE OR REPLACE FUNCTION public.cancel_sale(
  p_sale_id     uuid,
  p_business_id uuid,
  p_reason      text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sale record;
  v_line record;
BEGIN
  IF get_role(p_business_id) IS NULL OR get_role(p_business_id) NOT IN ('administrateur', 'manager', 'vendeur') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  SELECT id, seller_id, status INTO v_sale
  FROM sale_orders
  WHERE id = p_sale_id AND business_id = p_business_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vente introuvable' USING ERRCODE = 'P0001';
  END IF;

  IF v_sale.status = 'annule' THEN
    RETURN true;
  END IF;

  IF get_role(p_business_id) = 'vendeur' AND v_sale.seller_id != auth.uid() THEN
    RAISE EXCEPTION 'Un vendeur ne peut annuler que ses propres ventes' USING ERRCODE = 'P0001';
  END IF;

  UPDATE sale_orders
  SET status              = 'annule',
      cancelled_at        = now(),
      cancellation_reason = p_reason,
      cancelled_by_id     = auth.uid()
  WHERE id = p_sale_id;

  DELETE FROM payments WHERE order_id = p_sale_id;

  BEGIN
    FOR v_line IN
      SELECT product_id, variant_id, qty
      FROM so_lines
      WHERE order_id = p_sale_id
    LOOP
      INSERT INTO stock_moves (
        id, business_id, product_id, variant_id, type, qty, ref_id, ref_type, note, created_by
      ) VALUES (
        gen_random_uuid(), p_business_id, v_line.product_id, v_line.variant_id,
        'entree', v_line.qty, p_sale_id, 'annulation',
        'Annulation: ' || coalesce(p_reason, ''), auth.uid()
      );

      IF v_line.variant_id IS NOT NULL THEN
        UPDATE product_variants
        SET stock_qty = stock_qty + v_line.qty
        WHERE id = v_line.variant_id AND business_id = p_business_id;
      ELSE
        UPDATE products
        SET stock_qty = stock_qty + v_line.qty
        WHERE id = v_line.product_id AND business_id = p_business_id;
      END IF;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN true;
END;
$$;

-- ─── 4. upsert_product_variants() — archive, never DELETE; log stock ───────

CREATE OR REPLACE FUNCTION public.upsert_product_variants(
  p_business_id uuid,
  p_product_id  uuid,
  p_variants    jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item           jsonb;
  v_existing_id    uuid;
  v_existing_stock numeric;
  v_new_stock      numeric;
  v_delta          numeric;
  v_names          text[];
  v_id             uuid;
BEGIN
  IF get_role(p_business_id) IS NULL OR get_role(p_business_id) NOT IN ('administrateur', 'manager') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM products WHERE id = p_product_id AND business_id = p_business_id
  ) THEN
    RAISE EXCEPTION 'Produit introuvable' USING ERRCODE = 'P0001';
  END IF;

  IF jsonb_array_length(p_variants) = 0 THEN
    UPDATE product_variants
    SET archived = true, updated_at = now()
    WHERE product_id = p_product_id AND business_id = p_business_id;

    UPDATE products
    SET has_variants = false, updated_at = now()
    WHERE id = p_product_id AND business_id = p_business_id;
    RETURN;
  END IF;

  -- Upsert-by-name, preserving ids. The old DELETE-then-INSERT here broke a
  -- re-save after the first sale/PO because so_lines.variant_id /
  -- po_lines.variant_id reference product_variants(id) with NO ON DELETE.
  -- Removed variants are archived below instead of deleted.
  v_names := ARRAY(
    SELECT trim(v->>'name') FROM jsonb_array_elements(p_variants) v
  );

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_variants) LOOP
    v_new_stock := (v_item->>'stock_qty')::numeric;

    SELECT id, stock_qty INTO v_existing_id, v_existing_stock
      FROM product_variants
     WHERE product_id = p_product_id
       AND business_id = p_business_id
       AND name = trim(v_item->>'name')
     LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      UPDATE product_variants
         SET name          = trim(v_item->>'name'),
             sale_price    = (v_item->>'sale_price')::bigint,
             cost_price    = (v_item->>'cost_price')::bigint,
             reorder_level = (v_item->>'reorder_level')::numeric,
             stock_qty     = v_new_stock,
             archived      = false,
             updated_at    = now()
       WHERE id = v_existing_id;

      v_delta := v_new_stock - v_existing_stock;
      IF v_delta <> 0 THEN
        INSERT INTO stock_moves (
          id, business_id, product_id, variant_id, type, qty, ref_id, ref_type, note, created_by
        ) VALUES (
          gen_random_uuid(), p_business_id, p_product_id, v_existing_id,
          CASE WHEN v_delta > 0 THEN 'entree' ELSE 'perte' END,
          abs(v_delta), NULL, 'manuel',
          'Ajustement variante', auth.uid()
        );
      END IF;
    ELSE
      INSERT INTO product_variants (
        product_id, business_id, name, sale_price, cost_price, stock_qty, reorder_level
      ) VALUES (
        p_product_id, p_business_id, trim(v_item->>'name'),
        (v_item->>'sale_price')::bigint, (v_item->>'cost_price')::bigint,
        v_new_stock, (v_item->>'reorder_level')::numeric
      )
      RETURNING id INTO v_id;

      IF v_new_stock <> 0 THEN
        INSERT INTO stock_moves (
          id, business_id, product_id, variant_id, type, qty, ref_id, ref_type, note, created_by
        ) VALUES (
          gen_random_uuid(), p_business_id, p_product_id, v_id,
          'entree', v_new_stock, NULL, 'manuel',
          'Stock initial variante', auth.uid()
        );
      END IF;
    END IF;
  END LOOP;

  -- Archive any variant whose name is no longer present in this save.
  UPDATE product_variants
     SET archived = true, updated_at = now()
   WHERE product_id = p_product_id
     AND business_id = p_business_id
     AND name <> ALL(v_names);

  UPDATE products
     SET has_variants = true,
         stock_qty    = 0,
         updated_at   = now()
   WHERE id = p_product_id AND business_id = p_business_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_product_variants(uuid, uuid, jsonb) TO authenticated;

-- ─── 5. confirm_reception() — accept a real/backdated received date ────────
-- CREATE OR REPLACE cannot change a parameter list (it would create an
-- overload and PostgREST ambiguity), so the old 6-arg signature is dropped
-- explicitly before the 7-arg replacement.

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
    v_unit_cost  := (v_item->>'unit_cost_cents')::numeric / 100.0;

    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'Quantité invalide pour "%"', coalesce(v_item->>'name', 'un article') USING ERRCODE = 'P0001';
    END IF;

    IF v_product_id IS NULL THEN
      INSERT INTO products (business_id, name, supplier_id, cost_price, sale_price, created_by)
      VALUES (
        p_business_id,
        v_item->>'name',
        v_supplier_id,
        round(v_unit_cost * 100)::bigint,
        coalesce((v_item->>'sale_price_cents')::bigint, 0),
        auth.uid()
      )
      RETURNING id INTO v_product_id;
    ELSIF v_variant_id IS NULL AND nullif(v_item->>'sale_price_cents', '') IS NOT NULL THEN
      UPDATE products SET sale_price = (v_item->>'sale_price_cents')::bigint WHERE id = v_product_id;
    END IF;

    INSERT INTO po_lines (po_id, product_id, variant_id, qty_ordered, qty_received, unit_cost)
    VALUES (v_po_id, v_product_id, v_variant_id, v_qty, 0, v_unit_cost);

    v_total_cost := v_total_cost + v_qty * v_unit_cost;
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
