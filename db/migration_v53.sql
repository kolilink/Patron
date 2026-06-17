-- ============================================================
-- Patron — Migration v53
-- Run in Supabase SQL Editor AFTER migration_v52
--
-- Fix 1: join_business — don't burn rate-limit on non-existent codes.
--   The attempt counter now advances only after confirming the code
--   exists in the DB. Typing the wrong code (typo, copy error) no
--   longer counts against the 5-per-10-min limit.
--
-- Fix 2: record_client_payment RPC — atomic FIFO credit allocation.
--   Replaces the in-memory allocation in the client store with a
--   server-side function that holds row-level locks (FOR UPDATE).
--   Two devices paying the same client simultaneously will now
--   serialize correctly instead of double-paying.
--
-- Fix 3: create_product_with_stock RPC — atomic product creation.
--   Previously the store did products INSERT then stock_moves INSERT
--   as two separate calls. A failure between the two left a product
--   with no stock move, and the queue retry would fail on the
--   duplicate product key. This RPC wraps both in one transaction.
-- ============================================================


-- ─── Fix 1: join_business ─────────────────────────────────────────────────────
-- Only log an attempt after confirming the code exists.
-- Non-existent codes (typos, stale links) never burn an attempt.

CREATE OR REPLACE FUNCTION join_business(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      uuid := auth.uid();
  v_attempts int;
  v_invite   record;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Non authentifié'; END IF;

  -- Rate limit: 5 attempts per 10 minutes
  SELECT COUNT(*) INTO v_attempts
  FROM invite_attempts
  WHERE user_id = v_uid
    AND attempted_at > now() - interval '10 minutes';
  IF v_attempts >= 5 THEN
    RAISE EXCEPTION 'Trop de tentatives. Réessayez dans 10 minutes.' USING ERRCODE = 'P0001';
  END IF;

  -- Look up by code value only (no expiry/uses filter — we give specific errors below)
  SELECT id, business_id, role, expires_at, max_uses, uses
  INTO v_invite
  FROM invite_codes
  WHERE code = upper(trim(p_code))
  LIMIT 1;

  -- Unknown code → return NULL without logging an attempt (prevents lockout by typo)
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- Code exists — log the attempt now (expired and fully-used codes are real attempts)
  INSERT INTO invite_attempts (user_id) VALUES (v_uid);
  DELETE FROM invite_attempts WHERE attempted_at < now() - interval '1 hour';

  IF v_invite.expires_at IS NOT NULL AND v_invite.expires_at <= now() THEN
    RAISE EXCEPTION 'Ce code a expiré. Demandez un nouveau code à votre partenaire.'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_invite.max_uses IS NOT NULL AND v_invite.uses >= v_invite.max_uses THEN
    RAISE EXCEPTION 'Ce code a déjà été utilisé. Demandez un nouveau code à votre partenaire.'
      USING ERRCODE = 'P0001';
  END IF;

  IF (
    SELECT COUNT(*) FROM memberships
    WHERE user_id = v_uid AND role != 'administrateur'
  ) >= 3 THEN
    RAISE EXCEPTION 'Limite de 3 boutiques atteinte' USING ERRCODE = 'P0001';
  END IF;

  IF v_invite.role = 'manager' AND EXISTS (
    SELECT 1 FROM memberships
    WHERE business_id = v_invite.business_id AND role = 'manager'
  ) THEN
    RAISE EXCEPTION 'Cette boutique a déjà un gérant' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM memberships
    WHERE user_id = v_uid AND business_id = v_invite.business_id
  ) THEN
    RAISE EXCEPTION 'Vous êtes déjà membre de cette boutique' USING ERRCODE = '23505';
  END IF;

  UPDATE invite_codes SET uses = uses + 1 WHERE id = v_invite.id;
  INSERT INTO memberships (user_id, business_id, role)
  VALUES (v_uid, v_invite.business_id, v_invite.role);

  RETURN jsonb_build_object(
    'business_id', v_invite.business_id,
    'role',        v_invite.role
  );
END;
$$;
-- No GRANT needed — name and arg signature unchanged from v43/v46


-- ─── Fix 2: record_client_payment ─────────────────────────────────────────────
-- Atomic FIFO allocation with row-level locking.
-- p_amount is in integer cents (×100), matching all other monetary DB columns.

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
  IF get_role(p_business_id) NOT IN ('administrateur', 'manager', 'vendeur') THEN
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

GRANT EXECUTE ON FUNCTION record_client_payment(uuid, text, numeric, text, date) TO authenticated;


-- ─── Fix 3: create_product_with_stock ─────────────────────────────────────────
-- Single-transaction product + initial stock move.
-- p_product and p_stock_move are JSONB matching the store's productRow /
-- stockMoveRow shapes (monetary values already in integer cents).

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
  IF get_role(v_business_id) NOT IN ('administrateur', 'manager') THEN
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

GRANT EXECUTE ON FUNCTION create_product_with_stock(jsonb, jsonb) TO authenticated;
