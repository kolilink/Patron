-- ============================================================
-- Patron — Migration v26
-- Run in Supabase SQL Editor AFTER migration_v25
-- Adds idempotency key to sale_orders + submit_sale RPC.
--
-- BACKWARD COMPATIBLE: idempotency_key is nullable so the
-- binary currently under App Store review (which sends no key)
-- continues to work — NULL values never conflict with each other
-- on a UNIQUE index.
-- ============================================================

-- 1. Add nullable idempotency_key column to sale_orders
ALTER TABLE sale_orders
  ADD COLUMN IF NOT EXISTS idempotency_key UUID;

-- 2. Unique index (partial: only non-null values conflict)
CREATE UNIQUE INDEX IF NOT EXISTS sale_orders_idempotency_key_key
  ON sale_orders (idempotency_key)
  WHERE idempotency_key IS NOT NULL;


-- 3. Replace submit_sale() with idempotency-aware version
CREATE OR REPLACE FUNCTION public.submit_sale(
  p_business_id      uuid,
  p_seller_id        uuid,
  p_customer_name    text,
  p_sale_date        date,
  p_total_amount     numeric,
  p_discount_amount  numeric,
  p_is_credit        boolean,
  p_cart             jsonb,
  p_pay_method       text    DEFAULT NULL,
  p_pay_amount       numeric DEFAULT NULL,
  p_pay_ref          text    DEFAULT NULL,
  p_idempotency_key  uuid    DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order_id uuid;
  v_item     jsonb;
BEGIN
  -- Role check
  IF get_role(p_business_id) NOT IN ('administrateur', 'manager', 'vendeur') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF get_role(p_business_id) = 'vendeur' AND p_seller_id != auth.uid() THEN
    RAISE EXCEPTION 'Un vendeur ne peut enregistrer que ses propres ventes' USING ERRCODE = 'P0001';
  END IF;

  -- Idempotency: if this key was already used, return the existing order id
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_order_id
    FROM sale_orders
    WHERE idempotency_key = p_idempotency_key;

    IF FOUND THEN
      RETURN v_order_id;
    END IF;
  END IF;

  v_order_id := gen_random_uuid();

  -- 1. Create the order
  INSERT INTO sale_orders (
    id, business_id, customer_name, seller_id, status, is_credit,
    paid_at, sale_date, total_amount, discount_amount, created_by, idempotency_key
  ) VALUES (
    v_order_id,
    p_business_id,
    nullif(trim(coalesce(p_customer_name, '')), ''),
    p_seller_id,
    CASE WHEN p_is_credit THEN 'credit' ELSE 'paye' END,
    p_is_credit,
    CASE WHEN p_is_credit THEN NULL ELSE now() END,
    p_sale_date,
    p_total_amount,
    p_discount_amount,
    auth.uid(),
    p_idempotency_key
  );

  -- 2. Create order lines
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_cart) LOOP
    INSERT INTO so_lines (id, order_id, product_id, qty, unit_price, is_bulk)
    VALUES (
      gen_random_uuid(),
      v_order_id,
      (v_item->>'product_id')::uuid,
      (v_item->>'qty')::numeric,
      (v_item->>'unit_price')::numeric,
      coalesce((v_item->>'is_bulk')::boolean, false)
    );
  END LOOP;

  -- 3. Record payment if provided
  IF p_pay_method IS NOT NULL AND p_pay_amount IS NOT NULL AND p_pay_amount > 0 THEN
    INSERT INTO payments (id, order_id, customer_name, business_id, method, amount, date, ref_external)
    VALUES (
      gen_random_uuid(),
      v_order_id,
      nullif(trim(coalesce(p_customer_name, '')), ''),
      p_business_id,
      p_pay_method,
      p_pay_amount,
      p_sale_date,
      nullif(trim(coalesce(p_pay_ref, '')), '')
    );
  END IF;

  -- 4. Stock deduction (best-effort: sale is committed even if this fails)
  BEGIN
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

      UPDATE products
      SET stock_qty = GREATEST(0, stock_qty - (v_item->>'qty')::numeric)
      WHERE id = (v_item->>'product_id')::uuid;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN v_order_id;
END;
$$;

-- Grant must cover both old and new signatures
GRANT EXECUTE ON FUNCTION public.submit_sale(uuid, uuid, text, date, numeric, numeric, boolean, jsonb, text, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_sale(uuid, uuid, text, date, numeric, numeric, boolean, jsonb, text, numeric, text, uuid) TO authenticated;
