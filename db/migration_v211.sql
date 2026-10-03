-- ============================================================
-- Patron — Migration v211
-- Run in Supabase SQL Editor AFTER migration_v210
--
-- P0-1 fix: payments/cancels against pending (queued) sales were lost
-- at drain.
--
-- Offline-first write path: submit_quick_sale / submit_carnet_debt /
-- submit_sale are queued locally and projected into the pending overlay
-- with the projected local id = the sale's idempotency_key (see
-- lib/pendingOverlay.ts projectNewSale). When the user then pays or
-- cancels one of those projected sales before the queue drains, the
-- client sends the projected id (the idempotency_key) as p_sale_id.
--
-- record_payment and cancel_sale used p_sale_id directly in every
-- downstream statement, so a payment/cancel targeting a projected id
-- either raised "Vente introuvable" (the real row's id is a fresh
-- uuid, not the key) or — worse — silently resolved against a stale
-- balance. This migration makes both functions resolve the sale in two
-- steps: first WHERE id = p_sale_id, else WHERE idempotency_key =
-- p_sale_id, both scoped to p_business_id. The RESOLVED id is then used
-- for every downstream statement (balance check, payment insert/delete,
-- sale update, stock-restore loop).
-- ============================================================

-- ------------------------------------------------------------------
-- record_payment — two-step sale resolution
-- ------------------------------------------------------------------
DROP FUNCTION IF EXISTS record_payment(uuid, uuid, numeric, text, date);

CREATE OR REPLACE FUNCTION public.record_payment(
  p_sale_id          uuid,
  p_business_id      uuid,
  p_amount           numeric,
  p_method           text,
  p_date             date,
  p_idempotency_key  uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sale       record;
  v_sale_id    uuid;
  v_already    numeric;
  v_owed       numeric;
  v_fully_paid boolean;
  v_payment_id uuid;
BEGIN
  IF get_role(p_business_id) NOT IN ('administrateur', 'manager', 'vendeur') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Montant invalide' USING ERRCODE = 'P0001';
  END IF;

  -- Two-step resolution: p_sale_id may be the real sale_orders.id OR the
  -- idempotency_key a queued submit_quick_sale/submit_carnet_debt/
  -- submit_sale projected as its local id before drain. Resolve to the
  -- real row id once and use it everywhere downstream.
  SELECT id INTO v_sale_id
  FROM sale_orders
  WHERE id = p_sale_id AND business_id = p_business_id;

  IF v_sale_id IS NULL THEN
    SELECT id INTO v_sale_id
    FROM sale_orders
    WHERE idempotency_key = p_sale_id AND business_id = p_business_id;
  END IF;

  IF v_sale_id IS NULL THEN
    RAISE EXCEPTION 'Vente introuvable' USING ERRCODE = 'P0001';
  END IF;

  -- Idempotency: if this exact call already committed (a queued outbox
  -- item replaying after the original call actually succeeded but the
  -- client never heard back), don't insert a second payment — just
  -- report the sale's current paid state.
  IF p_idempotency_key IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM payments WHERE idempotency_key = p_idempotency_key) THEN
      SELECT id INTO v_payment_id
      FROM payments
      WHERE idempotency_key = p_idempotency_key;

      SELECT status = 'paye' INTO v_fully_paid
      FROM sale_orders
      WHERE id = v_sale_id AND business_id = p_business_id;

      RETURN jsonb_build_object('fully_paid', COALESCE(v_fully_paid, false), 'payment_id', v_payment_id);
    END IF;
  END IF;

  -- Locks the sale row so a racing payment attempt (a second offline queue
  -- replaying against the same debt, a retry, etc.) waits for this one to
  -- commit, then re-reads the up-to-date balance instead of working off
  -- whatever the phone last had cached.
  SELECT id, total_amount, discount_amount, customer_name
  INTO v_sale
  FROM sale_orders
  WHERE id = v_sale_id AND business_id = p_business_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vente introuvable' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_already
  FROM payments WHERE order_id = v_sale_id;

  v_owed := v_sale.total_amount - COALESCE(v_sale.discount_amount, 0);

  -- 1-unit tolerance for floating-point carry-over, matching record_client_payment.
  IF v_already + p_amount > v_owed + 1 THEN
    RAISE EXCEPTION 'Le montant dépasse le solde restant dû' USING ERRCODE = 'P0001';
  END IF;

  v_payment_id := gen_random_uuid();

  BEGIN
    INSERT INTO payments (id, order_id, customer_name, business_id, method, amount, date, idempotency_key)
    VALUES (
      v_payment_id, v_sale_id, v_sale.customer_name,
      p_business_id, p_method, p_amount, p_date, p_idempotency_key
    );
  EXCEPTION WHEN unique_violation THEN
    -- A concurrent call with the same key won the race between our
    -- existence check above and this insert — resolve exactly like the
    -- pre-check branch above, never insert a second row.
    SELECT id INTO v_payment_id
    FROM payments
    WHERE idempotency_key = p_idempotency_key;

    SELECT status = 'paye' INTO v_fully_paid
    FROM sale_orders
    WHERE id = v_sale_id AND business_id = p_business_id;
    RETURN jsonb_build_object('fully_paid', COALESCE(v_fully_paid, false), 'payment_id', v_payment_id);
  END;

  v_fully_paid := (v_already + p_amount) >= v_owed - 1;

  IF v_fully_paid THEN
    UPDATE sale_orders SET status = 'paye', paid_at = now() WHERE id = v_sale_id;
  END IF;

  RETURN jsonb_build_object('fully_paid', v_fully_paid, 'payment_id', v_payment_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_payment(uuid, uuid, numeric, text, date, uuid) TO authenticated;

-- ------------------------------------------------------------------
-- cancel_sale — two-step sale resolution
-- ------------------------------------------------------------------
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
  v_sale    record;
  v_sale_id uuid;
  v_line    record;
BEGIN
  IF get_role(p_business_id) NOT IN ('administrateur', 'manager', 'vendeur') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  -- Two-step resolution (see record_payment header above): p_sale_id may
  -- be the real row id OR the idempotency_key of a queued sale that was
  -- projected into the pending overlay before drain.
  SELECT id INTO v_sale_id
  FROM sale_orders
  WHERE id = p_sale_id AND business_id = p_business_id;

  IF v_sale_id IS NULL THEN
    SELECT id INTO v_sale_id
    FROM sale_orders
    WHERE idempotency_key = p_sale_id AND business_id = p_business_id;
  END IF;

  IF v_sale_id IS NULL THEN
    RAISE EXCEPTION 'Vente introuvable' USING ERRCODE = 'P0001';
  END IF;

  SELECT id, seller_id, status INTO v_sale
  FROM sale_orders
  WHERE id = v_sale_id AND business_id = p_business_id;

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
  WHERE id = v_sale_id;

  -- Delete payments created by submit_sale for this order.
  DELETE FROM payments WHERE order_id = v_sale_id;

  -- Restore stock for every line item.
  BEGIN
    FOR v_line IN
      SELECT product_id, variant_id, qty
      FROM so_lines
      WHERE order_id = v_sale_id
    LOOP
      INSERT INTO stock_moves (
        id, business_id, product_id, type, qty, ref_id, ref_type, note, created_by
      ) VALUES (
        gen_random_uuid(), p_business_id, v_line.product_id,
        'entree', v_line.qty, v_sale_id, 'annulation',
        'Annulation: ' || coalesce(p_reason, ''), auth.uid()
      );

      IF v_line.variant_id IS NOT NULL THEN
        -- Variant product: parent products.stock_qty is always 0 for
        -- variant parents (see submit_sale) — only the variant row moves.
        -- Defense-in-depth (kept from migration_v196): scope the restore
        -- by business so a so_lines row pointing at another business's
        -- variant can never move that variant's stock.
        UPDATE product_variants
        SET stock_qty = stock_qty + v_line.qty
        WHERE id = v_line.variant_id AND business_id = p_business_id;
      ELSE
        -- Defense-in-depth (kept from migration_v196): a so_lines row
        -- pointing at another business's product must not restore stock
        -- onto it.
        UPDATE products
        SET stock_qty = stock_qty + v_line.qty
        WHERE id = v_line.product_id AND business_id = p_business_id;
      END IF;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    NULL; -- stock restore is best-effort; cancellation itself is committed
  END;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_sale(uuid, uuid, text) TO authenticated;
