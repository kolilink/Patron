-- ============================================================
-- Patron — Migration v42
-- Run in Supabase SQL Editor AFTER migration_v41
--
-- Fixes the "two Mamadous merge into one ledger" bug by adding
-- a client_id FK to sale_orders. New sales set the FK when a
-- known client is selected at POS. Existing rows are backfilled
-- by matching customer_name + business_id.
-- ============================================================

-- 1. Add nullable client_id FK (SET NULL if client is deleted)
ALTER TABLE sale_orders
  ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES clients(id) ON DELETE SET NULL;

-- 2. Backfill: match existing sales to clients by exact name (case-insensitive) + business_id
UPDATE sale_orders so
SET client_id = c.id
FROM clients c
WHERE so.business_id = c.business_id
  AND so.customer_name IS NOT NULL
  AND LOWER(TRIM(so.customer_name)) = LOWER(TRIM(c.name))
  AND so.client_id IS NULL;

-- 3. Performance index (filtered: only rows with a client)
CREATE INDEX IF NOT EXISTS idx_sale_orders_client_id
  ON sale_orders(client_id)
  WHERE client_id IS NOT NULL;

-- 4. Replace submit_sale() with client_id-aware version
--    BACKWARD COMPATIBLE: p_client_id defaults to NULL so older
--    app versions (already in the field) continue to work.
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
  p_idempotency_key  uuid    DEFAULT NULL,
  p_client_id        uuid    DEFAULT NULL
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

  -- 1. Create the order (includes client_id when provided)
  INSERT INTO sale_orders (
    id, business_id, customer_name, client_id, seller_id, status, is_credit,
    paid_at, sale_date, total_amount, discount_amount, created_by, idempotency_key
  ) VALUES (
    v_order_id,
    p_business_id,
    nullif(trim(coalesce(p_customer_name, '')), ''),
    p_client_id,
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

-- Grant all signatures (old apps without p_client_id still work)
GRANT EXECUTE ON FUNCTION public.submit_sale(uuid, uuid, text, date, numeric, numeric, boolean, jsonb, text, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_sale(uuid, uuid, text, date, numeric, numeric, boolean, jsonb, text, numeric, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_sale(uuid, uuid, text, date, numeric, numeric, boolean, jsonb, text, numeric, text, uuid, uuid) TO authenticated;
