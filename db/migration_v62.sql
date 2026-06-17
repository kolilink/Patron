-- migration v62: fix submit_carnet_debt to only use columns that exist
--
-- submit_carnet_debt (v59/v60) tried to INSERT seller_name and amount_paid
-- into sale_orders, but neither column exists — they are computed client-side
-- by the ventes store. This migration:
--   1. Ensures all columns the RPC needs are present (idempotent ADD COLUMN IF NOT EXISTS)
--   2. Replaces submit_carnet_debt with a version that only touches real columns

-- ─── Ensure schema columns exist ──────────────────────────────────────────────

ALTER TABLE products    ADD COLUMN IF NOT EXISTS is_system       boolean      NOT NULL DEFAULT false;
ALTER TABLE sale_orders ADD COLUMN IF NOT EXISTS sale_date       date         DEFAULT CURRENT_DATE;
ALTER TABLE sale_orders ADD COLUMN IF NOT EXISTS is_credit       boolean      NOT NULL DEFAULT false;
ALTER TABLE sale_orders ADD COLUMN IF NOT EXISTS discount_amount numeric      NOT NULL DEFAULT 0;
ALTER TABLE sale_orders ADD COLUMN IF NOT EXISTS idempotency_key uuid;

-- ─── Replace submit_carnet_debt ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION submit_carnet_debt(
  p_business_id   uuid,
  p_seller_id     uuid,
  p_customer_name text,
  p_amount        bigint  -- already in cents (×100)
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
    id, business_id, seller_id, customer_name,
    status, is_credit, total_amount, discount_amount,
    sale_date, idempotency_key, created_at, updated_at, created_by
  ) VALUES (
    v_order_id, p_business_id, p_seller_id, p_customer_name,
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

GRANT EXECUTE ON FUNCTION submit_carnet_debt(uuid, uuid, text, bigint) TO authenticated;
