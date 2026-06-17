-- migration v59: carnet migration support
-- Adds is_system flag to products and submit_carnet_debt RPC so merchants can log
-- existing debts without creating products (paper-notebook migration flow).

ALTER TABLE products ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false;

-- submit_carnet_debt: creates a credit sale_order for a named customer with no cart,
-- no stock deduction, and no payment. Gets or creates the business's system product
-- "Solde reporté" (is_system = true) to satisfy the so_lines FK.
CREATE OR REPLACE FUNCTION submit_carnet_debt(
  p_business_id uuid,
  p_seller_id   uuid,
  p_customer_name text,
  p_amount      bigint  -- already in cents (×100)
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product_id  uuid;
  v_order_id    uuid;
  v_seller_name text;
BEGIN
  IF NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé';
  END IF;

  SELECT name INTO v_seller_name FROM profiles WHERE id = p_seller_id;

  -- Idempotent: get or create the single system product for this business.
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
    id, business_id, seller_id, seller_name, customer_name,
    status, is_credit, total_amount, discount_amount, amount_paid,
    sale_date, idempotency_key, created_at, updated_at
  ) VALUES (
    v_order_id, p_business_id, p_seller_id, COALESCE(v_seller_name, ''), p_customer_name,
    'credit', true, p_amount, 0, 0,
    CURRENT_DATE, gen_random_uuid(), NOW(), NOW()
  );

  INSERT INTO so_lines (
    id, sale_order_id, product_id, product_name,
    qty, unit_price, is_bulk, cost_price
  ) VALUES (
    gen_random_uuid(), v_order_id, v_product_id, 'Solde reporté',
    1, p_amount, false, 0
  );

  RETURN v_order_id;
END;
$$;

GRANT EXECUTE ON FUNCTION submit_carnet_debt(uuid, uuid, text, bigint) TO authenticated;
