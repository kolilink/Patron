-- ============================================================
-- Patron — Migration v196
-- Run in Supabase SQL Editor AFTER migration_v195
--
-- Security audit 2026-09-27 — full sweep of every SECURITY DEFINER function
-- that touches stock or money for the same unscoped-lookup pattern that
-- turned out to be real in submit_sale (migration_v195): a query inside a
-- definer function body that looks up/updates a row by a client-supplied id
-- without also constraining business_id to the caller's own. RLS gives zero
-- protection inside a SECURITY DEFINER body — the function's own WHERE
-- clauses are the only enforcement there is.
--
-- Six real, confirmed (by live cross-business test, not just reading) bugs
-- fixed here, ordered stock-moving first per the pass's own priority. #6
-- was NOT predicted by reading — the live test against unfixed code is what
-- surfaced it, the same lesson submit_sale's fuzz pass already taught:
--
-- 1. confirm_reception() — an existing product_id supplied in p_lines was
--    never checked against p_business_id before either (a) overwriting its
--    sale_price directly, or (b) inserting a po_lines row referencing it.
--    A caller could overwrite another business's product price, or splice
--    a foreign product/variant into their own purchase order.
-- 2. create_purchase_order() — same gap: po_lines was inserted straight
--    from p_lines' product_id/variant_id with no ownership check at all.
-- 3. receive_purchase_order() — the variant-stock path (product_variants
--    lookup + UPDATE) never constrained business_id, inconsistent with the
--    parallel plain-product path in the SAME function, which already did.
--    Defense-in-depth: with #1/#2 fixed, po_lines should never carry a
--    foreign product/variant id again, but a future edit that weakens
--    that upfront pass shouldn't silently reopen this on its own.
-- 4. cancel_sale() — the stock-restore loop's UPDATE products/
--    product_variants never constrained business_id either. Lower
--    severity in practice (ids come from so_lines of an already
--    business-scoped sale), same defense-in-depth reasoning as #3.
-- 5. create_product_with_stock() — p_stock_move's business_id and
--    created_by were trusted independently from the jsonb payload instead
--    of being forced to the already-validated v_business_id/auth.uid(),
--    letting a caller write a stock_moves row under a different business
--    id or misattribute it to a different user.
-- 6. upsert_product_variants() — the archive branch and the UPDATE
--    products call both correctly scoped by "AND business_id =
--    p_business_id", so a foreign p_product_id made those two no-ops —
--    exactly why a first reading pass called this one safe. But the
--    INSERT INTO product_variants branch never checked that p_product_id
--    actually belongs to p_business_id at all before writing — it created
--    a real variant row stamped with the CALLER's own business_id but the
--    VICTIM's product_id, a cross-referenced row that shouldn't be able to
--    exist. Caught only by the live test, not by reading: this file
--    originally listed this function under "proven safe" until the first
--    test run against unfixed code came back with a variant actually
--    created on the victim's product.
--
-- Functions read AND proven safe by a live test (no change needed), because
-- each either jointly scopes a lookup by business_id + the object id, or
-- derives the authorization-relevant business_id FROM the target row
-- itself rather than trusting a separate, independently-suppliable
-- business_id param: edit_sale, record_client_payment, pay_supplier_debt,
-- record_injection, edit_injection, record_withdrawal, request_payout,
-- confirm_payout, attach_transaction_proof, delete_transaction_proof. See
-- __tests__/integration/ for the live proof of each. submit_carnet_debt/
-- submit_sale/edit_sale's client_id param is a separate, much
-- lower-severity note (see CLAUDE.md) — a foreign client_id can be written
-- but nothing ever reads it cross-business, since every consumer already
-- scopes its own query by business_id first.
-- ============================================================

-- ── 1. confirm_reception() — validate existing product/variant ownership ────

CREATE OR REPLACE FUNCTION public.confirm_reception(
  p_business_id          uuid,
  p_supplier_id          uuid    DEFAULT NULL,
  p_po_id                uuid    DEFAULT NULL,
  p_lines                jsonb   DEFAULT '[]',
  p_transport_cost_cents bigint  DEFAULT 0,
  p_margin_percent       numeric DEFAULT NULL
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
      -- New product — variants are never asked for on a brand-new line.
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
    ELSE
      -- Existing product/variant referenced by id — must belong to this
      -- business, or this line splices a foreign row into the caller's
      -- own purchase order (and, for the sale_price branch below, lets a
      -- caller overwrite another business's product price outright).
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
        -- cost_price is deliberately left untouched here — AVCO below (via
        -- receive_purchase_order) is the single source of truth for it.
        UPDATE products SET sale_price = (v_item->>'sale_price_cents')::bigint
          WHERE id = v_product_id AND business_id = p_business_id;
      END IF;
    END IF;

    INSERT INTO po_lines (po_id, product_id, variant_id, qty_ordered, qty_received, unit_cost)
    VALUES (v_po_id, v_product_id, v_variant_id, v_qty, 0, v_unit_cost);

    v_total_cost := v_total_cost + v_qty * v_unit_cost;
  END LOOP;

  UPDATE purchase_orders SET total_cost = v_total_cost WHERE id = v_po_id;

  PERFORM receive_purchase_order(v_po_id, p_business_id, NULL, NULL, p_transport_cost_cents);

  RETURN v_po_id;
END;
$$;

-- ── 2. create_purchase_order() — validate every line's product/variant ──────

CREATE OR REPLACE FUNCTION public.create_purchase_order(
  p_business_id  uuid,
  p_supplier_id  uuid,
  p_lines        jsonb,
  p_amount_paid  numeric DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_po_id       uuid := gen_random_uuid();
  v_item        jsonb;
  v_total       numeric := 0;
  v_paid        numeric;
  v_owed        numeric;
  v_role        text;
BEGIN
  v_role := get_role(p_business_id);
  IF v_role IS NULL OR v_role NOT IN ('administrateur', 'manager') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'La commande doit contenir au moins une ligne' USING ERRCODE = 'P0001';
  END IF;

  -- Validate every line's product/variant belongs to this business before
  -- writing anything — same upfront-validation shape as submit_sale
  -- (migration_v195).
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM products WHERE id = (v_item->>'product_id')::uuid AND business_id = p_business_id
    ) THEN
      RAISE EXCEPTION 'Produit introuvable' USING ERRCODE = 'P0001';
    END IF;

    IF NULLIF(v_item->>'variant_id', '') IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM product_variants WHERE id = NULLIF(v_item->>'variant_id', '')::uuid AND business_id = p_business_id
    ) THEN
      RAISE EXCEPTION 'Produit introuvable' USING ERRCODE = 'P0001';
    END IF;

    v_total := v_total + (v_item->>'qty')::numeric * (v_item->>'unit_cost')::numeric;
  END LOOP;

  v_paid := COALESCE(p_amount_paid, v_total);
  v_owed := GREATEST(0, v_total - v_paid);

  INSERT INTO purchase_orders (id, business_id, supplier_id, status, ordered_at, total_cost, created_by)
  VALUES (v_po_id, p_business_id, p_supplier_id, 'brouillon', now(), v_total, auth.uid());

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    INSERT INTO po_lines (id, po_id, product_id, variant_id, qty_ordered, qty_received, unit_cost)
    VALUES (
      gen_random_uuid(), v_po_id,
      (v_item->>'product_id')::uuid,
      NULLIF(v_item->>'variant_id', '')::uuid,
      (v_item->>'qty')::numeric, 0,
      (v_item->>'unit_cost')::numeric
    );
  END LOOP;

  IF v_owed > 0.01 THEN
    INSERT INTO supplier_debts (business_id, supplier_id, po_id, amount, amount_paid, description, date, created_by)
    VALUES (p_business_id, p_supplier_id, v_po_id, ROUND(v_owed * 100)::bigint, 0, NULL, CURRENT_DATE, auth.uid());
  END IF;

  IF v_paid > 0.01 THEN
    INSERT INTO supplier_payments (business_id, supplier_id, po_id, amount_cents, paid_by, note)
    VALUES (p_business_id, p_supplier_id, v_po_id, ROUND(v_paid * 100)::bigint, auth.uid(), 'Paiement à la commande');
  END IF;

  RETURN v_po_id;
END;
$$;

-- ── 3. receive_purchase_order() — scope the variant AVCO path by business ───
--
-- Also drops a stale, unreachable 2-arg overload left over from before
-- confirm_reception existed (migration_v45.sql/v48.sql created
-- receive_purchase_order(uuid, uuid); every later signature change
-- correctly DROPped its own immediately-prior overload — v50, v65, v83,
-- v88 all do — but none of them ever went back for this original 2-arg
-- one, since at each of those points it had already stopped being the
-- "immediately prior" signature). No production caller is affected: the
-- only remaining direct caller is confirm_reception's own internal
-- PERFORM, which always passes all 5 positional args and is therefore
-- never ambiguous. But it broke a cross-business test written for this
-- sweep by satisfying PostgREST's 2-named-arg overload resolution
-- alongside the real function's all-default third-through-fifth params —
-- "Could not choose the best candidate function" — the exact ambiguity
-- CLAUDE.md's migration_v132/v153/v160/v178 notes already document for
-- this general shape of bug (CREATE OR REPLACE doesn't retire an old
-- signature when parameter count changes; only an explicit DROP does).
DROP FUNCTION IF EXISTS receive_purchase_order(uuid, uuid);

-- Merged with main's v158 (PR #41): the function logs a po_receipt_batches
-- row and RETURNS uuid (the batch id). This migration's own intent — scoping
-- the variant AVCO path by business_id — is preserved below on top of that
-- contract, along with the role-gate NULL-bypass guard (IS NULL OR).
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
      -- Scoped to this business — previously matched by id alone, unlike
      -- the plain-product path just below it in the same function.
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

-- ── 4. cancel_sale() — scope the stock-restore loop by business ─────────────

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
        id, business_id, product_id, type, qty, ref_id, ref_type, note, created_by
      ) VALUES (
        gen_random_uuid(), p_business_id, v_line.product_id,
        'entree', v_line.qty, p_sale_id, 'annulation',
        'Annulation: ' || coalesce(p_reason, ''), auth.uid()
      );

      IF v_line.variant_id IS NOT NULL THEN
        -- Defense-in-depth: v_line.product_id/variant_id come from so_lines
        -- of an already business-scoped sale, so this shouldn't be
        -- reachable today — but a future submit_sale weakening (or a row
        -- inserted some other way) shouldn't silently corrupt another
        -- business's stock via this loop having no filter of its own.
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

-- ── 5. create_product_with_stock() — force stock_move business_id/created_by ─

CREATE OR REPLACE FUNCTION create_product_with_stock(
  p_product    jsonb,
  p_stock_move jsonb DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product_id  uuid := (p_product->>'id')::uuid;
  v_business_id uuid := (p_product->>'business_id')::uuid;
BEGIN
  IF get_role(v_business_id) IS NULL OR get_role(v_business_id) NOT IN ('administrateur', 'manager') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO products (
    id, business_id, name, sku, category, unit,
    cost_price, sale_price, reorder_level, stock_qty, archived,
    supplier_id, purchase_date, bulk_price, bulk_min_qty, created_by
  ) VALUES (
    v_product_id,
    v_business_id,
    p_product->>'name',
    p_product->>'sku',
    p_product->>'category',
    p_product->>'unit',
    (p_product->>'cost_price')::numeric,
    (p_product->>'sale_price')::numeric,
    (p_product->>'reorder_level')::numeric,
    (p_product->>'stock_qty')::numeric,
    (p_product->>'archived')::boolean,
    (p_product->>'supplier_id')::uuid,
    (p_product->>'purchase_date')::date,
    (p_product->>'bulk_price')::numeric,
    (p_product->>'bulk_min_qty')::numeric,
    (p_product->>'created_by')::uuid
  );

  IF p_stock_move IS NOT NULL THEN
    -- business_id/created_by are forced to the already-validated values,
    -- never trusted from the jsonb payload — previously a caller could
    -- write a stock_moves row under an arbitrary business_id (unrelated to
    -- the product just created) and attribute it to an arbitrary user.
    INSERT INTO stock_moves (
      id, business_id, product_id, type, qty, ref_id, ref_type, note, created_by
    ) VALUES (
      (p_stock_move->>'id')::uuid,
      v_business_id,
      v_product_id,
      p_stock_move->>'type',
      (p_stock_move->>'qty')::numeric,
      (p_stock_move->>'ref_id')::uuid,
      p_stock_move->>'ref_type',
      p_stock_move->>'note',
      auth.uid()
    );
  END IF;

  RETURN v_product_id;
END;
$$;

-- ── 6. upsert_product_variants() — validate p_product_id ownership upfront ──

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
  v_item jsonb;
BEGIN
  IF get_role(p_business_id) IS NULL OR get_role(p_business_id) NOT IN ('administrateur', 'manager') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  -- The archive branch and the trailing UPDATE products below were already
  -- correctly scoped with "AND business_id = p_business_id", so a foreign
  -- p_product_id made those two safe no-ops. But the INSERT branch had no
  -- such check at all — it wrote a real product_variants row stamped with
  -- the CALLER's own business_id yet the VICTIM's product_id, a row that
  -- shouldn't be able to exist. Found live, not by reading: this function
  -- was first (wrongly) assessed safe on paper before this test caught it.
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
  ELSE
    DELETE FROM product_variants
    WHERE product_id = p_product_id AND business_id = p_business_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_variants) LOOP
      INSERT INTO product_variants (
        product_id, business_id, name,
        sale_price, cost_price, stock_qty, reorder_level
      ) VALUES (
        p_product_id,
        p_business_id,
        v_item->>'name',
        (v_item->>'sale_price')::bigint,
        (v_item->>'cost_price')::bigint,
        (v_item->>'stock_qty')::numeric,
        (v_item->>'reorder_level')::numeric
      );
    END LOOP;

    UPDATE products
    SET has_variants = true,
        stock_qty    = 0,
        updated_at   = now()
    WHERE id = p_product_id AND business_id = p_business_id;
  END IF;
END;
$$;
