-- ============================================================
-- Patron — Migration v157
-- Run in Supabase SQL Editor AFTER migration_v156
--
-- Adds a real reversal path for a credit repayment, closing the
-- gap flagged in CLAUDE.md's "SaveConfirmation" section: neither
-- record_payment nor record_client_payment had any compensating
-- action, so the "Annuler" window on a mis-tapped repayment could
-- only be faked client-side. This migration makes it real.
--
-- 1. payments gains voided_at/voided_by/void_reason (auditable,
--    append-only posture — the original row is never deleted or
--    mutated in place beyond these three columns).
-- 2. record_payment() now returns jsonb {fully_paid, payment_id}
--    instead of a bare boolean, so the client has the real
--    server-generated payment id to hand back to void_payment().
--    (Its own gen_random_uuid() insert already made a client-side
--    "paymentId" — used only for the optimistic UI row — useless
--    for this, since it was never the row actually written.)
--    Same treatment for record_client_payment(), which now returns
--    {fully_settled, payment_ids: uuid[]} — a single client payment
--    can fan out across multiple sale_orders (FIFO), so more than
--    one payments row can be created by a single call.
-- 3. void_payment(p_payment_id, p_business_id, p_reason) — voids
--    ONE payments row: marks it voided (not deleted), inserts a
--    compensating NEGATIVE payments row (mirrors record_withdrawal's
--    append-only pattern from migration_v115.sql — SUM(payments)
--    stays correct without touching history), and reopens the
--    parent sale_order to 'credit' if the reversal drops it below
--    fully-paid. Idempotent: voiding an already-voided payment
--    raises a clear error rather than double-reversing.
-- 4. Role-gated identically to record_payment/record_client_payment
--    (administrateur/manager/vendeur — the same roles that can
--    record a payment in the first place).
--
-- Client-side wiring (stores/ventes.ts, app/(app)/clients/[name].tsx)
-- lands in the same app-code change set as this migration — see
-- CLAUDE.md.
-- ============================================================

-- ─── 1. Audit columns on payments ──────────────────────────────

ALTER TABLE payments ADD COLUMN IF NOT EXISTS voided_at   timestamptz;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS voided_by   uuid REFERENCES auth.users(id);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS void_reason text;
-- Marks a compensating negative row as "belongs to this original payment" —
-- lets void_payment refuse to double-void, and lets the ledger UI group a
-- reversal with what it reversed instead of showing an unexplained negative line.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS reversal_of uuid REFERENCES payments(id);

-- ─── 2a. record_payment() — now returns payment_id too ────────

DROP FUNCTION IF EXISTS record_payment(uuid, uuid, numeric, text, date);

CREATE OR REPLACE FUNCTION public.record_payment(
  p_sale_id     uuid,
  p_business_id uuid,
  p_amount      numeric,
  p_method      text,
  p_date        date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sale       record;
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

  SELECT id, total_amount, discount_amount, customer_name
  INTO v_sale
  FROM sale_orders
  WHERE id = p_sale_id AND business_id = p_business_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vente introuvable' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_already
  FROM payments WHERE order_id = p_sale_id AND voided_at IS NULL;

  v_owed := v_sale.total_amount - COALESCE(v_sale.discount_amount, 0);

  IF v_already + p_amount > v_owed + 1 THEN
    RAISE EXCEPTION 'Le montant dépasse le solde restant dû' USING ERRCODE = 'P0001';
  END IF;

  v_payment_id := gen_random_uuid();
  INSERT INTO payments (id, order_id, customer_name, business_id, method, amount, date)
  VALUES (
    v_payment_id, p_sale_id, v_sale.customer_name,
    p_business_id, p_method, p_amount, p_date
  );

  v_fully_paid := (v_already + p_amount) >= v_owed - 1;

  IF v_fully_paid THEN
    UPDATE sale_orders SET status = 'paye', paid_at = now() WHERE id = p_sale_id;
  END IF;

  RETURN jsonb_build_object('fully_paid', v_fully_paid, 'payment_id', v_payment_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_payment(uuid, uuid, numeric, text, date) TO authenticated;

-- ─── 2b. record_client_payment() — now returns payment_ids too ─

DROP FUNCTION IF EXISTS record_client_payment(uuid, text, numeric, text, date);

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
  v_payment_id    uuid;
  v_payment_ids   uuid[] := '{}';
BEGIN
  IF get_role(p_business_id) NOT IN ('administrateur', 'manager', 'vendeur') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  FOR v_sale IN
    SELECT
      so.id,
      (so.total_amount - COALESCE(so.discount_amount, 0)) AS owed,
      COALESCE(
        (SELECT SUM(p.amount) FROM payments p WHERE p.order_id = so.id AND p.voided_at IS NULL),
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
    v_payment_id := gen_random_uuid();

    INSERT INTO payments (id, order_id, customer_name, business_id, method, amount, date)
    VALUES (
      v_payment_id, v_sale.id, p_customer_name,
      p_business_id, p_method, v_allocated, p_date
    );
    v_payment_ids := array_append(v_payment_ids, v_payment_id);

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

  RETURN jsonb_build_object(
    'fully_settled', v_fully_settled,
    'payment_ids', to_jsonb(v_payment_ids)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION record_client_payment(uuid, text, numeric, text, date) TO authenticated;

-- ─── 3. void_payment() — the actual reversal ───────────────────

CREATE OR REPLACE FUNCTION void_payment(
  p_payment_id  uuid,
  p_business_id uuid,
  p_reason      text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payment    record;
  v_sale       record;
  v_owed       numeric;
  v_still_paid numeric;
BEGIN
  IF get_role(p_business_id) NOT IN ('administrateur', 'manager', 'vendeur') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_payment
  FROM payments
  WHERE id = p_payment_id AND business_id = p_business_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Paiement introuvable' USING ERRCODE = 'P0001';
  END IF;

  -- Idempotent guard: never double-reverse. A retry (offline replay, a
  -- second Annuler tap racing the first) must be a clean no-op error, not
  -- a second compensating row.
  IF v_payment.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'Ce paiement a déjà été annulé' USING ERRCODE = 'P0001';
  END IF;
  IF v_payment.amount < 0 THEN
    RAISE EXCEPTION 'Impossible d''annuler une annulation' USING ERRCODE = 'P0001';
  END IF;

  UPDATE payments
     SET voided_at = now(), voided_by = auth.uid(), void_reason = p_reason
   WHERE id = p_payment_id;

  INSERT INTO payments (id, order_id, customer_name, business_id, method, amount, date, reversal_of)
  VALUES (
    gen_random_uuid(), v_payment.order_id, v_payment.customer_name,
    p_business_id, v_payment.method, -v_payment.amount, CURRENT_DATE, p_payment_id
  );

  -- Reopen the parent sale if this reversal drops it below fully-paid.
  IF v_payment.order_id IS NOT NULL THEN
    SELECT id, total_amount, discount_amount INTO v_sale
    FROM sale_orders WHERE id = v_payment.order_id FOR UPDATE;

    IF FOUND THEN
      v_owed := v_sale.total_amount - COALESCE(v_sale.discount_amount, 0);
      SELECT COALESCE(SUM(amount), 0) INTO v_still_paid
      FROM payments WHERE order_id = v_sale.id AND voided_at IS NULL;

      IF v_still_paid < v_owed - 1 THEN
        UPDATE sale_orders SET status = 'credit', paid_at = NULL WHERE id = v_sale.id;
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object('order_id', v_payment.order_id, 'amount', v_payment.amount);
END;
$$;

GRANT EXECUTE ON FUNCTION void_payment(uuid, uuid, text) TO authenticated;
