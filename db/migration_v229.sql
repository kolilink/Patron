-- ============================================================
-- Patron — Migration v229
-- Run in Supabase SQL Editor AFTER migration_v228
--
-- INTERRUPTION-PROOFING — réception goes through the offline outbox.
--
-- confirm_reception() was a direct RPC: in a dead zone the whole réception
-- died instead of queueing. To queue it, a replay must be harmless — the same
-- guarantee submit_sale/record_payment have. This adds p_idempotency_key:
--
--   * purchase_orders.reception_key (+ a partial unique index per business)
--     records which key created/closed an order.
--   * A replayed key returns the order the first call produced — no second
--     order, no second stock entry, no second transport expense.
--   * For a NEW order, the order's id IS the key. An offline client therefore
--     already knows the id its queued réception will create (the Confirmé step
--     keeps working), with no id mapping to maintain.
--   * Two replays racing: the loser's unique_violation rolls back its whole
--     subtransaction and it returns the winner's order.
--
-- Signature change => DROP the 7-arg overload first (CREATE OR REPLACE would
-- leave both callable and PostgREST named-argument calls ambiguous — see the
-- migration_v132 note in CLAUDE.md). The body is v221's, unchanged apart from
-- the key handling (business scoping, ownership validation, NULL = "Prix
-- inconnu", received_date all preserved).
-- ============================================================

ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS reception_key uuid;

CREATE UNIQUE INDEX IF NOT EXISTS purchase_orders_reception_key_idx
  ON purchase_orders (business_id, reception_key)
  WHERE reception_key IS NOT NULL;

DROP FUNCTION IF EXISTS public.confirm_reception(uuid, uuid, uuid, jsonb, bigint, numeric, date);

CREATE OR REPLACE FUNCTION public.confirm_reception(
  p_business_id          uuid,
  p_supplier_id          uuid    DEFAULT NULL,  -- NULL = "Marché"
  p_po_id                uuid    DEFAULT NULL,  -- Porte 2: existing order being confirmed
  p_lines                jsonb   DEFAULT '[]',
  p_transport_cost_cents bigint  DEFAULT 0,
  p_margin_percent       numeric DEFAULT NULL,
  p_received_date        date    DEFAULT NULL,   -- optional real/backdated delivery date
  p_idempotency_key      uuid    DEFAULT NULL    -- v229: client-generated; a replay returns the same order
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
  v_existing    uuid;
BEGIN
  IF get_role(p_business_id) IS NULL OR get_role(p_business_id) NOT IN ('administrateur', 'manager') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF p_lines IS NULL OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Ajoutez au moins un article' USING ERRCODE = 'P0001';
  END IF;

  -- v229: a replayed key (outbox retry after a lost response, a double drain)
  -- returns the order the first call created — never a second reception.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing FROM purchase_orders
      WHERE business_id = p_business_id AND reception_key = p_idempotency_key;
    IF FOUND THEN RETURN v_existing; END IF;
  END IF;

  v_supplier_id := resolve_reception_supplier(p_business_id, p_supplier_id);

  IF p_po_id IS NOT NULL THEN
    SELECT id INTO v_po_id FROM purchase_orders
      WHERE id = p_po_id AND business_id = p_business_id AND status NOT IN ('recu', 'annule');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Commande introuvable ou déjà terminée' USING ERRCODE = 'P0001';
    END IF;
    DELETE FROM po_lines WHERE po_id = v_po_id;
    UPDATE purchase_orders SET reception_key = p_idempotency_key WHERE id = v_po_id;
  ELSE
    -- The new order's id IS the key when one is given, so an offline client
    -- already knows the id of the order its queued reception will create.
    INSERT INTO purchase_orders (id, business_id, supplier_id, status, created_by, reception_key)
    VALUES (coalesce(p_idempotency_key, gen_random_uuid()), p_business_id, v_supplier_id, 'brouillon', auth.uid(), p_idempotency_key)
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
EXCEPTION WHEN unique_violation THEN
  -- Two replays of one key racing: the loser rolls back everything it did
  -- (nothing is double-booked) and returns the winner's order.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing FROM purchase_orders
      WHERE business_id = p_business_id AND reception_key = p_idempotency_key;
    IF FOUND THEN RETURN v_existing; END IF;
  END IF;
  RAISE;
END;
$$;


REVOKE EXECUTE ON FUNCTION public.confirm_reception(uuid, uuid, uuid, jsonb, bigint, numeric, date, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_reception(uuid, uuid, uuid, jsonb, bigint, numeric, date, uuid) TO authenticated;
