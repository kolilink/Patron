-- ============================================================
-- Patron — Migration v173
-- Run in Supabase SQL Editor AFTER migration_v172
--
-- SECURITY FIX — role-gate bypass for non-members, present since each
-- function's earliest version (some as far back as migration_v45/v53).
--
-- get_role(business_id) is `select role from memberships where user_id =
-- auth.uid() and business_id = bid limit 1` — it returns NULL, not an
-- error, when the caller has no membership row for that business at all
-- (not just the wrong role). Every affected function below gated access
-- with a bare `IF get_role(p_business_id) NOT IN ('administrateur',
-- 'manager', ...) THEN RAISE EXCEPTION ... END IF;` (or the `!=` form in
-- request_payout). Standard SQL three-valued logic makes `NULL NOT IN
-- (...)` evaluate to NULL, not TRUE — and plpgsql's IF statement treats a
-- NULL condition exactly like FALSE, silently skipping the THEN branch.
-- Net effect: any authenticated caller who is NOT a member of the target
-- business at all — not "the wrong role", genuinely no membership row —
-- fell through every one of these role checks as if it had passed.
--
-- Confirmed empirically against a local Supabase instance before writing
-- this fix (not just reasoned about): a brand-new, completely unrelated
-- user called submit_sale against another user's business_id and it
-- succeeded — no error, a real sale_order/so_lines/stock_moves/payments
-- row created, real stock deducted — see
-- __tests__/integration/_poc-null-role-bypass.integration.test.ts (temporary,
-- deleted once this fix lands). The same gap is real in every function
-- below; submit_sale was the one empirically reproduced because it's the
-- single highest-blast-radius case (every sale in the app goes through it).
--
-- Fix, applied identically everywhere: replace
--   IF get_role(x) NOT IN (...) THEN
-- with
--   IF get_role(x) IS NULL OR get_role(x) NOT IN (...) THEN
-- (and the equivalent for the one `!=` case in request_payout). No other
-- line changes — every function below is otherwise byte-identical to its
-- current live definition. All 13 signatures are unchanged from their
-- current versions, so CREATE OR REPLACE is safe here (no duplicate-
-- overload risk — see CLAUDE.md's migration_v132.sql note on why that
-- only matters when parameter *count* changes).
--
-- This same NULL guard was already added directly to the two brand-new,
-- not-yet-deployed functions in this same batch of work — see
-- migration_v168.sql (attach_transaction_proof) and migration_v172.sql
-- (create_purchase_order), both edited in place rather than reproduced
-- here as CREATE OR REPLACE, since neither had shipped yet.
--
-- Functions fixed here, each traced to its current (non-superseded)
-- definition before reproducing it — an earlier migration_v* number for
-- the same function name is dead code, already fully replaced by a later
-- CREATE OR REPLACE, and is not touched:
--   submit_sale                (was last defined in migration_v122.sql)
--   cancel_sale                (migration_v125.sql)
--   receive_purchase_order     (migration_v101.sql)
--   record_injection           (migration_v69.sql)
--   edit_injection             (migration_v115.sql)
--   record_withdrawal          (migration_v115.sql)
--   pay_supplier_debt          (migration_v74.sql)
--   confirm_payout             (migration_v78.sql)
--   request_payout             (migration_v78.sql — the `!=` form; lower
--                               severity in practice, since a non-member
--                               still has no investor_balance row and gets
--                               rejected by the very next check, but fixed
--                               anyway for the same reason as the rest)
--   edit_sale                  (migration_v153.sql)
--   upsert_product_variants    (migration_v65.sql)
--   record_client_payment      (migration_v53.sql)
--   create_product_with_stock  (migration_v53.sql)
-- ============================================================

-- ─── submit_sale ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.submit_sale(
  p_business_id      uuid,
  p_seller_id        uuid,
  p_customer_name    text      DEFAULT NULL,
  p_sale_date        date      DEFAULT CURRENT_DATE,
  p_total_amount     numeric   DEFAULT 0,
  p_discount_amount  numeric   DEFAULT 0,
  p_is_credit        boolean   DEFAULT false,
  p_cart             jsonb     DEFAULT '[]',
  p_pay_method       text      DEFAULT NULL,
  p_pay_amount       numeric   DEFAULT NULL,
  p_pay_ref          text      DEFAULT NULL,
  p_idempotency_key  uuid      DEFAULT NULL,
  p_client_id        uuid      DEFAULT NULL,
  p_due_date         date      DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order_id       uuid;
  v_item           jsonb;
  v_membership_id  uuid;
  v_has_scope      boolean;
  v_cost_price     bigint;
  v_unit_price_eff bigint;
  v_line_profit    bigint;
  v_investor       RECORD;
  v_rows_affected  integer;
BEGIN
  IF get_role(p_business_id) IS NULL OR get_role(p_business_id) NOT IN ('administrateur', 'manager', 'vendeur') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF get_role(p_business_id) = 'vendeur' AND p_seller_id != auth.uid() THEN
    RAISE EXCEPTION 'Un vendeur ne peut enregistrer que ses propres ventes' USING ERRCODE = 'P0001';
  END IF;

  IF get_role(p_business_id) = 'vendeur' THEN
    SELECT id INTO v_membership_id
    FROM memberships
    WHERE user_id = auth.uid() AND business_id = p_business_id;

    SELECT EXISTS(
      SELECT 1 FROM membership_product_scope WHERE membership_id = v_membership_id
    ) INTO v_has_scope;

    IF v_has_scope THEN
      PERFORM 1
      FROM jsonb_to_recordset(p_cart) AS c(product_id uuid)
      WHERE c.product_id NOT IN (
        SELECT product_id FROM membership_product_scope
        WHERE membership_id = v_membership_id
      );
      IF FOUND THEN
        RAISE EXCEPTION 'Produit non autorisé : ce vendeur ne peut pas vendre ce produit' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_order_id
    FROM sale_orders
    WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN RETURN v_order_id; END IF;
  END IF;

  v_order_id := gen_random_uuid();

  BEGIN
    INSERT INTO sale_orders (
      id, business_id, seller_id, customer_name, client_id,
      status, is_credit, paid_at, sale_date, due_date,
      total_amount, discount_amount, created_by, idempotency_key
    ) VALUES (
      v_order_id, p_business_id, p_seller_id,
      nullif(trim(coalesce(p_customer_name, '')), ''),
      p_client_id,
      CASE WHEN p_is_credit THEN 'credit' ELSE 'paye' END,
      p_is_credit,
      CASE WHEN NOT p_is_credit THEN now() ELSE NULL END,
      p_sale_date,
      CASE WHEN p_is_credit THEN p_due_date ELSE NULL END,
      p_total_amount, p_discount_amount,
      auth.uid(), p_idempotency_key
    );
  EXCEPTION WHEN unique_violation THEN
    -- Race: another concurrent request with the same key committed first.
    -- Return its order ID so the client gets an idempotent response instead
    -- of a raw duplicate-key error.
    IF p_idempotency_key IS NOT NULL THEN
      SELECT id INTO v_order_id
      FROM sale_orders
      WHERE idempotency_key = p_idempotency_key;
      IF FOUND THEN RETURN v_order_id; END IF;
    END IF;
    RAISE;
  END;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_cart) LOOP
    -- Cost snapshot: variant first, fall back to parent product
    v_cost_price := NULL;
    IF nullif(v_item->>'variant_id', '') IS NOT NULL THEN
      SELECT cost_price INTO v_cost_price
      FROM product_variants
      WHERE id = nullif(v_item->>'variant_id', '')::uuid;
    END IF;
    IF v_cost_price IS NULL THEN
      SELECT cost_price INTO v_cost_price
      FROM products
      WHERE id = (v_item->>'product_id')::uuid;
    END IF;

    INSERT INTO so_lines (
      id, order_id, product_id, product_name,
      qty, unit_price, is_bulk,
      variant_id, variant_name,
      cost_price_at_sale
    ) VALUES (
      gen_random_uuid(), v_order_id,
      (v_item->>'product_id')::uuid,
      v_item->>'product_name',
      (v_item->>'qty')::numeric,
      (v_item->>'unit_price')::numeric,
      coalesce((v_item->>'is_bulk')::boolean, false),
      nullif(v_item->>'variant_id', '')::uuid,
      nullif(v_item->>'variant_name', ''),
      v_cost_price
    );
  END LOOP;

  IF p_pay_method IS NOT NULL AND p_pay_amount IS NOT NULL AND p_pay_amount > 0 THEN
    INSERT INTO payments (id, order_id, customer_name, business_id, method, amount, date, ref_external)
    VALUES (
      gen_random_uuid(), v_order_id,
      nullif(trim(coalesce(p_customer_name, '')), ''),
      p_business_id, p_pay_method, p_pay_amount, p_sale_date,
      nullif(trim(coalesce(p_pay_ref, '')), '')
    );
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_cart) LOOP
    INSERT INTO stock_moves (
      id, business_id, product_id, type, qty, ref_id, ref_type, note, created_by
    ) VALUES (
      gen_random_uuid(), p_business_id,
      (v_item->>'product_id')::uuid,
      'sortie',
      (v_item->>'qty')::numeric,
      v_order_id, 'sale_order', NULL, auth.uid()
    );

    IF nullif(v_item->>'variant_id', '') IS NOT NULL THEN
      -- Variant product: guard is on product_variants (parent products.stock_qty
      -- is always 0 for variant parents so no meaningful guard there).
      UPDATE products
      SET stock_qty = GREATEST(0, stock_qty - (v_item->>'qty')::numeric)
      WHERE id = (v_item->>'product_id')::uuid;

      UPDATE product_variants
      SET stock_qty = stock_qty - (v_item->>'qty')::numeric
      WHERE id     = nullif(v_item->>'variant_id', '')::uuid
        AND stock_qty >= (v_item->>'qty')::numeric;

      GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
      IF v_rows_affected = 0 THEN
        RAISE EXCEPTION 'Stock insuffisant : %',
          coalesce(nullif(v_item->>'variant_name', ''), v_item->>'product_name', 'Produit inconnu')
          USING ERRCODE = 'P0001';
      END IF;
    ELSE
      -- Plain product: guard is on products.
      UPDATE products
      SET stock_qty = stock_qty - (v_item->>'qty')::numeric
      WHERE id      = (v_item->>'product_id')::uuid
        AND stock_qty >= (v_item->>'qty')::numeric;

      GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
      IF v_rows_affected = 0 THEN
        RAISE EXCEPTION 'Stock insuffisant : %',
          coalesce(v_item->>'product_name', 'Produit inconnu')
          USING ERRCODE = 'P0001';
      END IF;
    END IF;

    -- Investor profit accumulation: unit_price is now always the real price charged.
    v_cost_price := NULL;
    IF nullif(v_item->>'variant_id', '') IS NOT NULL THEN
      SELECT cost_price INTO v_cost_price
      FROM product_variants
      WHERE id = nullif(v_item->>'variant_id', '')::uuid;
    END IF;
    IF v_cost_price IS NULL THEN
      SELECT cost_price INTO v_cost_price
      FROM products
      WHERE id = (v_item->>'product_id')::uuid;
    END IF;

    v_unit_price_eff := (v_item->>'unit_price')::bigint;

    v_line_profit := GREATEST(0,
      (v_unit_price_eff - coalesce(v_cost_price, 0))
      * (v_item->>'qty')::bigint
    );

    IF v_line_profit > 0 THEN
      FOR v_investor IN
        SELECT m.user_id, mps.profit_share
        FROM membership_product_scope mps
        JOIN memberships m ON m.id = mps.membership_id
        WHERE mps.product_id  = (v_item->>'product_id')::uuid
          AND m.business_id   = p_business_id
          AND m.role          = 'investisseur'
          AND mps.profit_share > 0
      LOOP
        INSERT INTO investor_balance (business_id, investor_id, balance, updated_at)
        VALUES (
          p_business_id,
          v_investor.user_id,
          ROUND(v_line_profit * v_investor.profit_share / 100.0)::bigint,
          now()
        )
        ON CONFLICT (business_id, investor_id) DO UPDATE
          SET balance    = investor_balance.balance
                         + ROUND(v_line_profit * v_investor.profit_share / 100.0)::bigint,
              updated_at = now();
      END LOOP;
    END IF;
  END LOOP;

  RETURN v_order_id;
END;
$$;

-- ─── cancel_sale ────────────────────────────────────────────────────────────

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

  -- Idempotent: already cancelled — return without touching anything again.
  IF v_sale.status = 'annule' THEN
    RETURN true;
  END IF;

  IF get_role(p_business_id) = 'vendeur' AND v_sale.seller_id != auth.uid() THEN
    RAISE EXCEPTION 'Un vendeur ne peut annuler que ses propres ventes' USING ERRCODE = 'P0001';
  END IF;

  -- Mark the sale as cancelled.
  UPDATE sale_orders
  SET status              = 'annule',
      cancelled_at        = now(),
      cancellation_reason = p_reason,
      cancelled_by_id     = auth.uid()
  WHERE id = p_sale_id;

  -- Delete payments created by submit_sale for this order.
  DELETE FROM payments WHERE order_id = p_sale_id;

  -- Restore stock for every line item.
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
        -- Variant product: parent products.stock_qty is always 0 for
        -- variant parents (see submit_sale) — only the variant row moves.
        UPDATE product_variants
        SET stock_qty = stock_qty + v_line.qty
        WHERE id = v_line.variant_id;
      ELSE
        UPDATE products
        SET stock_qty = stock_qty + v_line.qty
        WHERE id = v_line.product_id;
      END IF;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    NULL; -- stock restore is best-effort; cancellation itself is committed
  END;

  RETURN true;
END;
$$;

-- ─── receive_purchase_order ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION receive_purchase_order(
  p_po_id               uuid,
  p_business_id         uuid,
  p_line_ids            uuid[]  DEFAULT NULL,
  p_line_qtys           int[]   DEFAULT NULL,
  p_shipping_cost_cents bigint  DEFAULT 0
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  l                  RECORD;
  recv_qty           int;
  total_lines        int;
  received_lines     int;

  -- Shipping allocation
  total_value_cents  bigint := 0;
  line_value_cents   bigint;
  shipping_allocated bigint := 0;
  line_shipping      bigint;
  line_count         int := 0;
  current_line       int := 0;

  -- AVCO
  v_current_stock    numeric;
  v_current_cost     bigint;
  v_landed_cost      bigint;
  v_new_cost         bigint;

  -- For expense description
  v_supplier_name    text;
  v_po_date          date;
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

  -- Pre-pass: compute total value of lines being received
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

  -- Main loop: stock move + AVCO update per line
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

    -- Shipping allocation by value
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

    -- Stock move
    INSERT INTO stock_moves (id, business_id, product_id, type, qty, ref_id, ref_type, note, created_by)
    VALUES (
      gen_random_uuid(), p_business_id, l.product_id,
      'entree', recv_qty, p_po_id, 'purchase_order',
      'Commande reçue', auth.uid()
    );

    -- AVCO cost update
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

  -- Auto-create transport expense linked to this PO
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
    );
  END IF;

  -- Final PO status
  SELECT COUNT(*) INTO total_lines    FROM po_lines WHERE po_id = p_po_id;
  SELECT COUNT(*) INTO received_lines FROM po_lines WHERE po_id = p_po_id AND qty_received >= qty_ordered;

  UPDATE purchase_orders
     SET status      = CASE WHEN received_lines = total_lines THEN 'recu' ELSE 'recu_partiel' END,
         received_at = CASE WHEN received_lines = total_lines THEN now() ELSE received_at END
   WHERE id = p_po_id;
END;
$$;

-- ─── record_injection ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.record_injection(
  p_business_id      uuid,
  p_amount           bigint,          -- cents ×100
  p_injected_by_id   uuid    DEFAULT NULL,
  p_source_name      text    DEFAULT NULL,
  p_note             text    DEFAULT NULL,
  p_injected_at      date    DEFAULT CURRENT_DATE
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF get_role(p_business_id) IS NULL OR get_role(p_business_id) NOT IN ('administrateur', 'manager') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Le montant doit être positif' USING ERRCODE = 'P0001';
  END IF;

  v_id := gen_random_uuid();

  INSERT INTO capital_injections (
    id, business_id, amount,
    injected_by_id, source_name, note,
    injected_at, created_by
  ) VALUES (
    v_id, p_business_id, p_amount,
    p_injected_by_id,
    nullif(trim(coalesce(p_source_name, '')), ''),
    nullif(trim(coalesce(p_note, '')), ''),
    p_injected_at,
    auth.uid()
  );

  RETURN v_id;
END;
$$;

-- ─── edit_injection ─────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.edit_injection(
  p_id               uuid,
  p_amount           bigint,          -- cents ×100, must be > 0 (edits never target a withdrawal row)
  p_injected_by_id   uuid    DEFAULT NULL,
  p_source_name      text    DEFAULT NULL,
  p_note             text    DEFAULT NULL,
  p_injected_at      date    DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business_id uuid;
BEGIN
  SELECT business_id INTO v_business_id FROM capital_injections WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Apport introuvable' USING ERRCODE = 'P0001';
  END IF;

  IF get_role(v_business_id) IS NULL OR get_role(v_business_id) NOT IN ('administrateur', 'manager') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Le montant doit être positif' USING ERRCODE = 'P0001';
  END IF;

  UPDATE capital_injections SET
    amount          = p_amount,
    injected_by_id  = p_injected_by_id,
    source_name     = nullif(trim(coalesce(p_source_name, '')), ''),
    note            = nullif(trim(coalesce(p_note, '')), ''),
    injected_at     = coalesce(p_injected_at, injected_at),
    edited_at       = now(),
    edited_by       = auth.uid()
  WHERE id = p_id;
END;
$$;

-- ─── record_withdrawal ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.record_withdrawal(
  p_business_id      uuid,
  p_amount           bigint,          -- cents ×100, positive input — stored as negative
  p_injected_by_id   uuid    DEFAULT NULL,
  p_source_name      text    DEFAULT NULL,
  p_note             text    DEFAULT NULL,
  p_withdrawn_at     date    DEFAULT CURRENT_DATE
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF get_role(p_business_id) IS NULL OR get_role(p_business_id) NOT IN ('administrateur', 'manager') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Le montant doit être positif' USING ERRCODE = 'P0001';
  END IF;

  v_id := gen_random_uuid();

  INSERT INTO capital_injections (
    id, business_id, amount,
    injected_by_id, source_name, note,
    injected_at, created_by
  ) VALUES (
    v_id, p_business_id, -p_amount,
    p_injected_by_id,
    nullif(trim(coalesce(p_source_name, '')), ''),
    nullif(trim(coalesce(p_note, '')), ''),
    p_withdrawn_at,
    auth.uid()
  );

  RETURN v_id;
END;
$$;

-- ─── pay_supplier_debt ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.pay_supplier_debt(
  p_business_id  uuid,
  p_supplier_id  uuid,
  p_amount_cents bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_remaining   bigint := p_amount_cents;
  v_allocated   bigint := 0;
  v_debt        record;
  v_outstanding bigint;
  v_paying      bigint;
BEGIN
  IF get_role(p_business_id) IS NULL OR get_role(p_business_id) NOT IN ('administrateur', 'manager') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'Le montant doit être positif' USING ERRCODE = 'P0001';
  END IF;

  -- FOR UPDATE locks each debt row before reading its balance,
  -- preventing concurrent double-payment on the same debt.
  FOR v_debt IN
    SELECT id, amount, amount_paid
    FROM supplier_debts
    WHERE business_id = p_business_id
      AND supplier_id = p_supplier_id
      AND amount      > amount_paid
    ORDER BY created_at ASC
    FOR UPDATE
  LOOP
    IF v_remaining <= 0 THEN EXIT; END IF;

    v_outstanding := v_debt.amount - v_debt.amount_paid;
    v_paying      := LEAST(v_remaining, v_outstanding);

    UPDATE supplier_debts
    SET amount_paid = amount_paid + v_paying
    WHERE id = v_debt.id;

    v_remaining := v_remaining - v_paying;
    v_allocated := v_allocated + v_paying;
  END LOOP;

  -- Log only what was actually allocated (not the requested amount)
  IF v_allocated > 0 THEN
    INSERT INTO public.supplier_payments (business_id, supplier_id, amount_cents, paid_by)
    VALUES (p_business_id, p_supplier_id, v_allocated, auth.uid());
  END IF;

  RETURN jsonb_build_object('remaining_cents', v_remaining);
END;
$$;

-- ─── confirm_payout / request_payout ────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.request_payout(
  p_business_id uuid,
  p_amount      bigint
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance    bigint;
  v_payout_id  uuid;
BEGIN
  -- Must be an investor in this business
  IF get_role(p_business_id) IS NULL OR get_role(p_business_id) != 'investisseur' THEN
    RAISE EXCEPTION 'Seuls les investisseurs peuvent faire une demande de retrait' USING ERRCODE = 'P0001';
  END IF;

  -- Fetch current balance
  SELECT balance INTO v_balance
  FROM investor_balance
  WHERE business_id = p_business_id AND investor_id = auth.uid();

  IF v_balance IS NULL OR v_balance = 0 THEN
    RAISE EXCEPTION 'Vous n''avez pas de solde disponible' USING ERRCODE = 'P0001';
  END IF;

  IF p_amount > v_balance THEN
    RAISE EXCEPTION 'Le montant demandé dépasse votre solde disponible' USING ERRCODE = 'P0001';
  END IF;

  -- Only one pending request at a time
  IF EXISTS (
    SELECT 1 FROM investor_payouts
    WHERE business_id = p_business_id
      AND investor_id = auth.uid()
      AND status = 'en_attente'
  ) THEN
    RAISE EXCEPTION 'Vous avez déjà une demande en attente' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO investor_payouts (business_id, investor_id, requested_amount)
  VALUES (p_business_id, auth.uid(), p_amount)
  RETURNING id INTO v_payout_id;

  RETURN v_payout_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.confirm_payout(
  p_payout_id   uuid,
  p_paid_amount bigint
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payout investor_payouts%ROWTYPE;
BEGIN
  SELECT * INTO v_payout FROM investor_payouts WHERE id = p_payout_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Demande introuvable' USING ERRCODE = 'P0001';
  END IF;

  IF get_role(v_payout.business_id) IS NULL OR get_role(v_payout.business_id) NOT IN ('administrateur', 'manager') THEN
    RAISE EXCEPTION 'Action non autorisée' USING ERRCODE = 'P0001';
  END IF;

  IF v_payout.status != 'en_attente' THEN
    RAISE EXCEPTION 'Cette demande a déjà été traitée' USING ERRCODE = 'P0001';
  END IF;

  IF p_paid_amount > v_payout.requested_amount THEN
    RAISE EXCEPTION 'Le montant payé ne peut pas dépasser le montant demandé' USING ERRCODE = 'P0001';
  END IF;

  UPDATE investor_payouts
  SET paid_amount = p_paid_amount,
      status      = 'paye',
      paid_at     = now(),
      paid_by     = auth.uid()
  WHERE id = p_payout_id;

  -- Deduct from balance (floor at 0 to guard against any race)
  UPDATE investor_balance
  SET balance    = GREATEST(0, balance - p_paid_amount),
      updated_at = now()
  WHERE business_id = v_payout.business_id
    AND investor_id  = v_payout.investor_id;
END;
$$;

-- ─── edit_sale ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.edit_sale(
  p_sale_id          uuid,
  p_business_id      uuid,
  p_customer_name    text    DEFAULT NULL,
  p_client_id        uuid    DEFAULT NULL,
  p_due_date         date    DEFAULT NULL,
  p_discount_amount  bigint  DEFAULT 0,
  p_line_edits       jsonb   DEFAULT '[]',
  p_payment_edits    jsonb   DEFAULT '[]',
  p_reason           text    DEFAULT NULL
)
RETURNS sale_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sale         sale_orders;
  v_max_edits    int;
  v_window_hours int;
  v_line         jsonb;
  v_line_row     so_lines;
  v_pay          jsonb;
  v_pay_row      payments;
  v_new_total    bigint;
  v_new_paid     bigint;
  v_new_owed     bigint;
  v_cost         bigint;
  v_old_profit   bigint;
  v_new_profit   bigint;
  v_delta        bigint;
  v_investor     RECORD;
  v_before       jsonb;
  v_after        jsonb;
  v_result       sale_orders;
BEGIN
  IF get_role(p_business_id) IS NULL OR get_role(p_business_id) NOT IN ('administrateur', 'manager') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_sale FROM sale_orders WHERE id = p_sale_id AND business_id = p_business_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vente introuvable' USING ERRCODE = 'P0001';
  END IF;

  IF v_sale.status NOT IN ('paye', 'credit') THEN
    RAISE EXCEPTION 'Seules les ventes payées ou à crédit peuvent être modifiées' USING ERRCODE = 'P0001';
  END IF;

  SELECT value INTO v_max_edits    FROM app_config WHERE key = 'sale_edit_max_count';
  SELECT value INTO v_window_hours FROM app_config WHERE key = 'sale_edit_window_hours';

  IF v_sale.edit_count >= v_max_edits THEN
    RAISE EXCEPTION 'Cette vente a atteint le nombre maximum de modifications (%). Annulez-la et recréez-la si besoin.', v_max_edits USING ERRCODE = 'P0001';
  END IF;

  IF now() - v_sale.created_at > (v_window_hours || ' hours')::interval THEN
    RAISE EXCEPTION 'Le délai de modification (% heures) est dépassé pour cette vente', v_window_hours USING ERRCODE = 'P0001';
  END IF;

  IF p_discount_amount < 0 THEN
    RAISE EXCEPTION 'La remise ne peut pas être négative' USING ERRCODE = 'P0001';
  END IF;

  -- Snapshot "before" — whole shape, taken before any write below.
  SELECT jsonb_build_object(
    'customer_name',   v_sale.customer_name,
    'client_id',       v_sale.client_id,
    'due_date',        v_sale.due_date,
    'total_amount',    v_sale.total_amount,
    'discount_amount', v_sale.discount_amount,
    'lines', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'line_id', id, 'product_name', COALESCE(product_name, ''), 'unit_price', unit_price
             ) ORDER BY id), '[]'::jsonb)
      FROM so_lines WHERE order_id = p_sale_id
    ),
    'payments', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'payment_id', id, 'method', method, 'amount', amount, 'ref_external', ref_external
             ) ORDER BY id), '[]'::jsonb)
      FROM payments WHERE order_id = p_sale_id
    )
  ) INTO v_before;

  -- Apply line-price corrections (partial list — only the lines being changed).
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_line_edits) LOOP
    SELECT * INTO v_line_row FROM so_lines
      WHERE id = (v_line->>'line_id')::uuid AND order_id = p_sale_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Ligne de vente introuvable' USING ERRCODE = 'P0001';
    END IF;
    IF (v_line->>'unit_price')::bigint < 0 THEN
      RAISE EXCEPTION 'Le prix ne peut pas être négatif' USING ERRCODE = 'P0001';
    END IF;

    IF (v_line->>'unit_price')::bigint != v_line_row.unit_price THEN
      -- Investor profit-share delta: submit_sale credited investor_balance
      -- once at sale time based on the original price; that ledger is
      -- additive, never recomputed from source, so a price correction
      -- must apply the delta here or the balance silently drifts forever.
      v_cost       := COALESCE(v_line_row.cost_price_at_sale, 0);
      v_old_profit := GREATEST(0, (v_line_row.unit_price - v_cost) * v_line_row.qty);
      v_new_profit := GREATEST(0, ((v_line->>'unit_price')::bigint - v_cost) * v_line_row.qty);
      v_delta      := v_new_profit - v_old_profit;

      IF v_delta != 0 THEN
        FOR v_investor IN
          SELECT m.user_id, mps.profit_share
          FROM membership_product_scope mps
          JOIN memberships m ON m.id = mps.membership_id
          WHERE mps.product_id  = v_line_row.product_id
            AND m.business_id   = p_business_id
            AND m.role          = 'investisseur'
            AND mps.profit_share > 0
        LOOP
          INSERT INTO investor_balance (business_id, investor_id, balance, updated_at)
          VALUES (
            p_business_id, v_investor.user_id,
            ROUND(v_delta * v_investor.profit_share / 100.0)::bigint, now()
          )
          ON CONFLICT (business_id, investor_id) DO UPDATE
            SET balance    = investor_balance.balance
                           + ROUND(v_delta * v_investor.profit_share / 100.0)::bigint,
                updated_at = now();
        END LOOP;
      END IF;

      UPDATE so_lines SET unit_price = (v_line->>'unit_price')::bigint WHERE id = v_line_row.id;
    END IF;
  END LOOP;

  -- total_amount is always server-derived from the lines as they now
  -- stand — never trusted from the client — so check #9 (total vs. sum
  -- of lines) holds by construction, not by being patched.
  SELECT COALESCE(SUM(qty * unit_price), 0)::bigint INTO v_new_total
  FROM so_lines WHERE order_id = p_sale_id;

  IF p_discount_amount >= v_new_total THEN
    RAISE EXCEPTION 'La remise doit être inférieure au total' USING ERRCODE = 'P0001';
  END IF;

  -- Apply payment corrections (partial list — only the payments being changed).
  FOR v_pay IN SELECT * FROM jsonb_array_elements(p_payment_edits) LOOP
    SELECT * INTO v_pay_row FROM payments
      WHERE id = (v_pay->>'payment_id')::uuid AND order_id = p_sale_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Paiement introuvable' USING ERRCODE = 'P0001';
    END IF;
    IF (v_pay->>'amount')::bigint < 0 THEN
      RAISE EXCEPTION 'Le montant payé ne peut pas être négatif' USING ERRCODE = 'P0001';
    END IF;

    UPDATE payments SET
      method       = v_pay->>'method',
      amount       = (v_pay->>'amount')::bigint,
      ref_external = nullif(trim(coalesce(v_pay->>'ref_external', '')), '')
    WHERE id = v_pay_row.id;
  END LOOP;

  SELECT COALESCE(SUM(amount), 0)::bigint INTO v_new_paid FROM payments WHERE order_id = p_sale_id;
  v_new_owed := v_new_total - p_discount_amount;

  -- The one hard money rule: an edit can correct numbers, but it can
  -- never leave the sale in a state reconciliation would flag as wrong.
  IF v_sale.status = 'credit' THEN
    IF v_new_paid > v_new_owed THEN
      RAISE EXCEPTION 'Le montant déjà payé (%) dépasserait le nouveau montant dû (%) — ajustez aussi le paiement', ROUND(v_new_paid / 100.0)::bigint, ROUND(v_new_owed / 100.0)::bigint USING ERRCODE = 'P0001';
    END IF;
  ELSE -- 'paye'
    IF v_new_paid != v_new_owed THEN
      RAISE EXCEPTION 'Le total payé (%) doit correspondre au montant dû (%) pour une vente payée — ajustez aussi le paiement', ROUND(v_new_paid / 100.0)::bigint, ROUND(v_new_owed / 100.0)::bigint USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE sale_orders SET
    customer_name   = nullif(trim(coalesce(p_customer_name, '')), ''),
    client_id       = p_client_id,
    due_date        = CASE WHEN v_sale.is_credit THEN p_due_date ELSE NULL END,
    total_amount    = v_new_total,
    discount_amount = p_discount_amount,
    edit_count      = v_sale.edit_count + 1,
    last_edited_at  = now(),
    last_edited_by  = auth.uid()
  WHERE id = p_sale_id
  RETURNING * INTO v_result;

  SELECT jsonb_build_object(
    'customer_name',   v_result.customer_name,
    'client_id',       v_result.client_id,
    'due_date',        v_result.due_date,
    'total_amount',    v_result.total_amount,
    'discount_amount', v_result.discount_amount,
    'lines', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'line_id', id, 'product_name', COALESCE(product_name, ''), 'unit_price', unit_price
             ) ORDER BY id), '[]'::jsonb)
      FROM so_lines WHERE order_id = p_sale_id
    ),
    'payments', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'payment_id', id, 'method', method, 'amount', amount, 'ref_external', ref_external
             ) ORDER BY id), '[]'::jsonb)
      FROM payments WHERE order_id = p_sale_id
    )
  ) INTO v_after;

  INSERT INTO sale_order_edits (id, order_id, edit_number, edited_by, reason, before, after)
  VALUES (gen_random_uuid(), p_sale_id, v_result.edit_count, auth.uid(), nullif(trim(coalesce(p_reason, '')), ''), v_before, v_after);

  RETURN v_result;
END;
$$;

-- ─── upsert_product_variants ────────────────────────────────────────────────

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

  IF jsonb_array_length(p_variants) = 0 THEN
    UPDATE product_variants
    SET archived = true, updated_at = now()
    WHERE product_id = p_product_id AND business_id = p_business_id;

    UPDATE products
    SET has_variants = false, updated_at = now()
    WHERE id = p_product_id AND business_id = p_business_id;
  ELSE
    -- Delete-then-insert is safe: so_lines.variant_name is a snapshot, so
    -- historical sale lines are unaffected by variant deletions.
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

-- ─── record_client_payment ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION record_client_payment(
  p_business_id   uuid,
  p_customer_name text,
  p_amount        numeric,
  p_method        text,
  p_date          date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_remaining     numeric := p_amount;
  v_sale          record;
  v_outstanding   numeric;
  v_allocated     numeric;
  v_new_paid      numeric;
  v_fully_settled boolean;
BEGIN
  IF get_role(p_business_id) IS NULL OR get_role(p_business_id) NOT IN ('administrateur', 'manager', 'vendeur') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  -- FOR UPDATE locks each row before we read its paid balance — serializes
  -- concurrent payment calls and prevents double-payment.
  FOR v_sale IN
    SELECT
      so.id,
      (so.total_amount - COALESCE(so.discount_amount, 0)) AS owed,
      COALESCE(
        (SELECT SUM(p.amount) FROM payments p WHERE p.order_id = so.id),
        0
      ) AS already_paid
    FROM sale_orders so
    WHERE so.business_id   = p_business_id
      AND so.customer_name = p_customer_name
      AND so.status        = 'credit'
    ORDER BY so.created_at ASC
    FOR UPDATE OF so
  LOOP
    IF v_remaining <= 0 THEN EXIT; END IF;

    v_outstanding := v_sale.owed - v_sale.already_paid;
    IF v_outstanding <= 0 THEN CONTINUE; END IF;

    v_allocated := LEAST(v_remaining, v_outstanding);
    v_new_paid  := v_sale.already_paid + v_allocated;

    INSERT INTO payments (id, order_id, customer_name, business_id, method, amount, date)
    VALUES (
      gen_random_uuid(), v_sale.id, p_customer_name,
      p_business_id, p_method, v_allocated, p_date
    );

    -- 1-cent tolerance for floating-point carry-over from older records
    IF v_new_paid >= v_sale.owed - 1 THEN
      UPDATE sale_orders SET status = 'paye', paid_at = now() WHERE id = v_sale.id;
    END IF;

    v_remaining := v_remaining - v_allocated;
  END LOOP;

  SELECT NOT EXISTS (
    SELECT 1 FROM sale_orders
    WHERE business_id   = p_business_id
      AND customer_name = p_customer_name
      AND status        = 'credit'
  ) INTO v_fully_settled;

  RETURN jsonb_build_object('fully_settled', v_fully_settled);
END;
$$;

-- ─── create_product_with_stock ──────────────────────────────────────────────

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
    INSERT INTO stock_moves (
      id, business_id, product_id, type, qty, ref_id, ref_type, note, created_by
    ) VALUES (
      (p_stock_move->>'id')::uuid,
      (p_stock_move->>'business_id')::uuid,
      v_product_id,
      p_stock_move->>'type',
      (p_stock_move->>'qty')::numeric,
      (p_stock_move->>'ref_id')::uuid,
      p_stock_move->>'ref_type',
      p_stock_move->>'note',
      (p_stock_move->>'created_by')::uuid
    );
  END IF;

  RETURN v_product_id;
END;
$$;
