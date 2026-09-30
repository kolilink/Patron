-- ============================================================
-- Patron — Migration v203
-- Run in Supabase SQL Editor AFTER migration_v202
--
-- Adds real idempotency to record_client_payment(), for the offline-first
-- rewrite (§7 of the approved plan — the per-RPC idempotency audit named
-- this function as the real gap: it had no idempotency mechanism of any
-- kind before this). Needed so the outbox can safely retry a queued
-- payment without risking double-applying it if the original call
-- actually succeeded server-side but the client never heard back.
--
-- Structurally different from submit_sale/submit_carnet_debt's pattern
-- (a single idempotency_key column + partial unique index on ONE row that
-- call always produces): record_client_payment's FIFO allocation can fan
-- out into a VARIABLE number of `payments` rows per call — 0 (nothing
-- owed), 1, or N (spread across several of the customer's credit sales).
-- Putting idempotency_key directly on `payments` would mean only the
-- FIRST row of a multi-sale allocation could carry it, which is fragile
-- and doesn't generalize. Instead: a dedicated single-purpose claim table,
-- record_client_payment_idempotency_keys — one row per logical CALL
-- (never per resulting payment row), claimed atomically before the
-- allocation loop runs at all. A claim only persists if the whole
-- transaction commits (ordinary Postgres atomicity), so a call that fails
-- partway for any other reason correctly frees its key for retry.
-- ============================================================

CREATE TABLE IF NOT EXISTS record_client_payment_idempotency_keys (
  idempotency_key uuid PRIMARY KEY,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- No client-facing RLS policy — reachable only from inside this
-- SECURITY DEFINER function, same posture as djomi_pending_payments/
-- support_ai_drafts elsewhere in this schema.
ALTER TABLE record_client_payment_idempotency_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON record_client_payment_idempotency_keys FROM PUBLIC, anon, authenticated;

DROP FUNCTION IF EXISTS record_client_payment(uuid, text, numeric, text, date);

CREATE OR REPLACE FUNCTION record_client_payment(
  p_business_id      uuid,
  p_customer_name    text,
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
  v_remaining     numeric := p_amount;
  v_sale          record;
  v_outstanding   numeric;
  v_allocated     numeric;
  v_new_paid      numeric;
  v_fully_settled boolean;
  v_already_claimed boolean := false;
  v_payment_id    uuid;
  v_payment_ids   uuid[] := '{}';
BEGIN
  IF get_role(p_business_id) IS NULL OR get_role(p_business_id) NOT IN ('administrateur', 'manager', 'vendeur') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  -- Claim the idempotency key BEFORE doing any allocation work — this is
  -- what makes "exactly once" true regardless of how many payments rows
  -- the loop below ends up creating. A caller with no key (p_idempotency_key
  -- IS NULL) always proceeds — same "opt-in, backward compatible" posture
  -- migration_v26's sale_orders.idempotency_key already established.
  IF p_idempotency_key IS NOT NULL THEN
    BEGIN
      INSERT INTO record_client_payment_idempotency_keys (idempotency_key)
      VALUES (p_idempotency_key);
    EXCEPTION WHEN unique_violation THEN
      -- Already processed (a prior call with this exact key already
      -- committed), or a concurrent call with the same key is already
      -- claiming it. Either way, this call must not allocate anything —
      -- skip straight to recomputing and returning the current state.
      v_already_claimed := true;
    END;
  END IF;

  IF NOT v_already_claimed THEN
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

      v_payment_id := gen_random_uuid();

      INSERT INTO payments (id, order_id, customer_name, business_id, method, amount, date)
      VALUES (
        v_payment_id, v_sale.id, p_customer_name,
        p_business_id, p_method, v_allocated, p_date
      );

      v_payment_ids := array_append(v_payment_ids, v_payment_id);

      -- 1-cent tolerance for floating-point carry-over from older records
      IF v_new_paid >= v_sale.owed - 1 THEN
        UPDATE sale_orders SET status = 'paye', paid_at = now() WHERE id = v_sale.id;
      END IF;

      v_remaining := v_remaining - v_allocated;
    END LOOP;
  END IF;

  SELECT NOT EXISTS (
    SELECT 1 FROM sale_orders
    WHERE business_id   = p_business_id
      AND customer_name = p_customer_name
      AND status        = 'credit'
  ) INTO v_fully_settled;

  RETURN jsonb_build_object('fully_settled', v_fully_settled, 'payment_ids', to_jsonb(v_payment_ids));
END;
$$;

GRANT EXECUTE ON FUNCTION record_client_payment(uuid, text, numeric, text, date, uuid) TO authenticated;
