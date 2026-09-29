-- ============================================================
-- Patron — Migration v205
-- Run in Supabase SQL Editor AFTER migration_v204
--
-- Adds real idempotency to record_payment() — the prerequisite for
-- converting it to local-write-first (offline outbox Phase 1 follow-up),
-- the same order of operations migration_v203 already established for
-- record_client_payment: that migration's own header comment states
-- plainly that going local-write-first without a real idempotency
-- mechanism first would let an outbox retry double-apply a payment.
-- record_payment had NO idempotency mechanism of any kind before this —
-- confirmed by reading its current body (migration_v105.sql) — so it
-- could not safely be queued-first until this shipped.
--
-- Unlike record_client_payment's FIFO allocation (which can fan out into
-- a variable number of `payments` rows per call, hence that migration's
-- dedicated claim table), record_payment always inserts exactly ONE
-- `payments` row per call against one already-known sale_id — the exact
-- same shape submit_sale's idempotency_key already handles (migration_v26).
-- So this mirrors that pattern directly: a nullable idempotency_key
-- column on `payments` + a partial unique index, instead of a separate
-- claim table.
-- ============================================================

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS idempotency_key uuid;

CREATE UNIQUE INDEX IF NOT EXISTS payments_idempotency_key_key
  ON payments (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

DROP FUNCTION IF EXISTS record_payment(uuid, uuid, numeric, text, date);

CREATE OR REPLACE FUNCTION public.record_payment(
  p_sale_id          uuid,
  p_business_id      uuid,
  p_amount           numeric,
  p_method           text,
  p_date             date,
  p_idempotency_key  uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sale       record;
  v_already    numeric;
  v_owed       numeric;
  v_fully_paid boolean;
BEGIN
  IF get_role(p_business_id) NOT IN ('administrateur', 'manager', 'vendeur') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Montant invalide' USING ERRCODE = 'P0001';
  END IF;

  -- Idempotency: if this exact call already committed (a queued outbox
  -- item replaying after the original call actually succeeded but the
  -- client never heard back), don't insert a second payment — just
  -- report the sale's current paid state.
  IF p_idempotency_key IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM payments WHERE idempotency_key = p_idempotency_key) THEN
      SELECT status = 'paye' INTO v_fully_paid
      FROM sale_orders
      WHERE id = p_sale_id AND business_id = p_business_id;

      RETURN COALESCE(v_fully_paid, false);
    END IF;
  END IF;

  -- Locks the sale row so a racing payment attempt (a second offline queue
  -- replaying against the same debt, a retry, etc.) waits for this one to
  -- commit, then re-reads the up-to-date balance instead of working off
  -- whatever the phone last had cached.
  SELECT id, total_amount, discount_amount, customer_name
  INTO v_sale
  FROM sale_orders
  WHERE id = p_sale_id AND business_id = p_business_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vente introuvable' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_already
  FROM payments WHERE order_id = p_sale_id;

  v_owed := v_sale.total_amount - COALESCE(v_sale.discount_amount, 0);

  -- 1-unit tolerance for floating-point carry-over, matching record_client_payment.
  IF v_already + p_amount > v_owed + 1 THEN
    RAISE EXCEPTION 'Le montant dépasse le solde restant dû' USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    INSERT INTO payments (id, order_id, customer_name, business_id, method, amount, date, idempotency_key)
    VALUES (
      gen_random_uuid(), p_sale_id, v_sale.customer_name,
      p_business_id, p_method, p_amount, p_date, p_idempotency_key
    );
  EXCEPTION WHEN unique_violation THEN
    -- A concurrent call with the same key won the race between our
    -- existence check above and this insert — resolve exactly like the
    -- pre-check branch above, never insert a second row.
    SELECT status = 'paye' INTO v_fully_paid
    FROM sale_orders
    WHERE id = p_sale_id AND business_id = p_business_id;
    RETURN COALESCE(v_fully_paid, false);
  END;

  v_fully_paid := (v_already + p_amount) >= v_owed - 1;

  IF v_fully_paid THEN
    UPDATE sale_orders SET status = 'paye', paid_at = now() WHERE id = p_sale_id;
  END IF;

  RETURN v_fully_paid;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_payment(uuid, uuid, numeric, text, date, uuid) TO authenticated;
