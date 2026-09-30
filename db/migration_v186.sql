-- ============================================================
-- Patron — Migration v186
-- Run in Supabase SQL Editor AFTER migration_v185
--
-- Adds real idempotency to submit_carnet_debt(), mirroring submit_sale's
-- pattern exactly (migration_v122.sql: pre-check + BEGIN/EXCEPTION WHEN
-- unique_violation guard). Needed so the client can safely queue a credit
-- entry offline and replay it later without ever risking a duplicate debt
-- if the original call actually succeeded server-side but the client
-- never heard back (timeout, connection drop mid-response). Same DROP-
-- then-CREATE OR REPLACE requirement as v132/v153/v160 — parameter count
-- is changing (5 → 6), which CREATE OR REPLACE alone does not handle.
-- ============================================================

DROP FUNCTION IF EXISTS submit_carnet_debt(uuid, uuid, text, bigint, uuid);

CREATE OR REPLACE FUNCTION submit_carnet_debt(
  p_business_id      uuid,
  p_seller_id        uuid,
  p_customer_name    text,
  p_amount           bigint,  -- already in cents (×100)
  p_client_id        uuid DEFAULT NULL,
  p_idempotency_key  uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product_id uuid;
  v_order_id   uuid;
BEGIN
  IF NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_order_id FROM sale_orders WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN RETURN v_order_id; END IF;
  END IF;

  -- Get or create the single system product for this business.
  SELECT id INTO v_product_id
  FROM products
  WHERE business_id = p_business_id AND is_system = true AND archived = false
  LIMIT 1;

  IF NOT FOUND THEN
    v_product_id := gen_random_uuid();
    INSERT INTO products (
      id, business_id, name, unit,
      cost_price, sale_price, stock_qty, reorder_level,
      archived, is_system, created_by, created_at, updated_at
    ) VALUES (
      v_product_id, p_business_id, 'Solde reporté', 'unité',
      0, 0, 999999, 0,
      false, true, p_seller_id, NOW(), NOW()
    );
  END IF;

  v_order_id := gen_random_uuid();

  BEGIN
    INSERT INTO sale_orders (
      id, business_id, seller_id, customer_name, client_id,
      status, is_credit, total_amount, discount_amount,
      sale_date, idempotency_key, created_at, updated_at, created_by
    ) VALUES (
      v_order_id, p_business_id, p_seller_id, p_customer_name, p_client_id,
      'credit', true, p_amount, 0,
      CURRENT_DATE, coalesce(p_idempotency_key, gen_random_uuid()), NOW(), NOW(), p_seller_id
    );
  EXCEPTION WHEN unique_violation THEN
    -- Race: another concurrent call with the same key committed first
    -- (offline-queue retry racing a live retry, or two devices post-
    -- reconnect) — return its order instead of raising a raw duplicate-key
    -- error, same recovery submit_sale already has.
    IF p_idempotency_key IS NOT NULL THEN
      SELECT id INTO v_order_id FROM sale_orders WHERE idempotency_key = p_idempotency_key;
      IF FOUND THEN RETURN v_order_id; END IF;
    END IF;
    RAISE;
  END;

  INSERT INTO so_lines (
    id, order_id, product_id, product_name,
    qty, unit_price, is_bulk
  ) VALUES (
    gen_random_uuid(), v_order_id, v_product_id, 'Solde reporté',
    1, p_amount, false
  );

  RETURN v_order_id;
END;
$$;

GRANT EXECUTE ON FUNCTION submit_carnet_debt(uuid, uuid, text, bigint, uuid, uuid) TO authenticated;
