-- ============================================================
-- Patron — Migration v57
-- Run in Supabase SQL Editor AFTER migration_v56
--
-- Adds optional due_date (DATE) to sale_orders so sellers can
-- record when a credit customer promised to pay back.
-- Updates submit_sale to accept the new p_due_date parameter.
-- ============================================================

-- 1. Add column
ALTER TABLE sale_orders
  ADD COLUMN IF NOT EXISTS due_date DATE;

-- 2. Drop old submit_sale (13 params) and recreate with due_date (14 params)
DROP FUNCTION IF EXISTS public.submit_sale(uuid,uuid,text,date,numeric,numeric,boolean,jsonb,text,numeric,text,uuid,uuid);

CREATE OR REPLACE FUNCTION public.submit_sale(
  p_business_id      uuid,
  p_seller_id        uuid,
  p_customer_name    text    DEFAULT NULL,
  p_sale_date        date    DEFAULT CURRENT_DATE,
  p_total_amount     numeric DEFAULT 0,
  p_discount_amount  numeric DEFAULT 0,
  p_is_credit        boolean DEFAULT false,
  p_cart             jsonb   DEFAULT '[]',
  p_pay_method       text    DEFAULT NULL,
  p_pay_amount       numeric DEFAULT NULL,
  p_pay_ref          text    DEFAULT NULL,
  p_idempotency_key  uuid    DEFAULT NULL,
  p_client_id        uuid    DEFAULT NULL,
  p_due_date         date    DEFAULT NULL
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
  IF get_role(p_business_id) NOT IN ('administrateur', 'manager', 'vendeur') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF get_role(p_business_id) = 'vendeur' AND p_seller_id != auth.uid() THEN
    RAISE EXCEPTION 'Un vendeur ne peut enregistrer que ses propres ventes' USING ERRCODE = 'P0001';
  END IF;

  -- Idempotency: return existing order if same key already committed
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_order_id
    FROM sale_orders
    WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN RETURN v_order_id; END IF;
  END IF;

  v_order_id := gen_random_uuid();

  INSERT INTO sale_orders (
    id, business_id, seller_id, customer_name, client_id,
    status, is_credit, paid_at, sale_date, due_date,
    total_amount, discount_amount, created_by, idempotency_key
  ) VALUES (
    v_order_id, p_business_id, p_seller_id,
    nullif(trim(coalesce(p_customer_name, '')), ''),
    p_client_id,
    CASE WHEN p_is_credit THEN 'credit' ELSE 'paye' END,
    p_is_credit,
    CASE WHEN NOT p_is_credit THEN now() ELSE NULL END,
    p_sale_date,
    CASE WHEN p_is_credit THEN p_due_date ELSE NULL END,
    p_total_amount, p_discount_amount,
    auth.uid(), p_idempotency_key
  );

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_cart) LOOP
    INSERT INTO so_lines (id, order_id, product_id, product_name, qty, unit_price)
    VALUES (
      gen_random_uuid(), v_order_id,
      (v_item->>'product_id')::uuid,
      v_item->>'product_name',
      (v_item->>'qty')::numeric,
      (v_item->>'unit_price')::numeric
    );
  END LOOP;

  IF p_pay_method IS NOT NULL AND p_pay_amount IS NOT NULL AND p_pay_amount > 0 THEN
    INSERT INTO payments (id, order_id, customer_name, business_id, method, amount, date, ref_external)
    VALUES (
      gen_random_uuid(), v_order_id,
      nullif(trim(coalesce(p_customer_name, '')), ''),
      p_business_id, p_pay_method, p_pay_amount, p_sale_date,
      nullif(trim(coalesce(p_pay_ref, '')), '')
    );
  END IF;

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

  RETURN v_order_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_sale(uuid,uuid,text,date,numeric,numeric,boolean,jsonb,text,numeric,text,uuid,uuid,date) TO authenticated;
