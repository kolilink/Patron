-- ============================================================
-- Patron — Migration v160
-- Run in Supabase SQL Editor AFTER migration_v159
--
-- submit_sale() has accepted p_client_id since migration_v42.sql, but its
-- sibling submit_carnet_debt() (the "Crédit rapide" quick-debt entry point
-- in Vendre) never got the same treatment — found during an audit for the
-- same bug SHAPE as the fournisseurs variant_id fix (migration_v159.sql): a
-- real, correctly-resolved id, known at the UI layer, silently discarded
-- before it reaches the database. Here the resolved client id was never
-- even a parameter to drop — submit_carnet_debt had no way to accept one.
--
-- Concrete, already-live damage this causes: the client balance shown in
-- Vendre's own carnet tab (app/(app)/(tabs)/vendre.tsx) is computed by
-- filtering sale_orders strictly on client_id, no name fallback — so every
-- debt ever added via this tab was invisible to that balance check. A
-- returning client's shown balance reads too low, sometimes zero, even
-- though they genuinely owe money. (The client list and per-client ledger
-- screens happen to fall back to matching by customer_name when client_id
-- is null, so they aren't showing wrong numbers today — but that reopens
-- the exact "two different clients, same name" collision client_id was
-- introduced in v42 to prevent, specifically for this one entry path.)
--
-- CREATE OR REPLACE does not edit a function in place when the parameter
-- COUNT changes (see migration_v132.sql's note on this exact footgun) —
-- Postgres would otherwise leave the old 4-arg signature live alongside
-- this new 5-arg one, ambiguous for any caller still supplying only the
-- original params. Explicit DROP first, same pattern v132/v153 already use.
-- ============================================================

DROP FUNCTION IF EXISTS submit_carnet_debt(uuid, uuid, text, bigint);

CREATE OR REPLACE FUNCTION submit_carnet_debt(
  p_business_id   uuid,
  p_seller_id     uuid,
  p_customer_name text,
  p_amount        bigint,  -- already in cents (×100)
  p_client_id     uuid DEFAULT NULL
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

  INSERT INTO sale_orders (
    id, business_id, seller_id, customer_name, client_id,
    status, is_credit, total_amount, discount_amount,
    sale_date, idempotency_key, created_at, updated_at, created_by
  ) VALUES (
    v_order_id, p_business_id, p_seller_id, p_customer_name, p_client_id,
    'credit', true, p_amount, 0,
    CURRENT_DATE, gen_random_uuid(), NOW(), NOW(), p_seller_id
  );

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

GRANT EXECUTE ON FUNCTION submit_carnet_debt(uuid, uuid, text, bigint, uuid) TO authenticated;
