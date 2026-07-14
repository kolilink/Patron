-- ============================================================
-- Patron — Migration v122
-- Run in Supabase SQL Editor AFTER migration_v121
--
-- Fix: migration_v52 wrapped submit_sale's sale_orders INSERT in a
-- `BEGIN ... EXCEPTION WHEN unique_violation THEN ...` block so that
-- two concurrent calls sharing the same idempotency_key (e.g. an
-- offline-queue retry racing a live retry on the same device, or two
-- devices racing after a reconnect) both resolve to the same order
-- instead of one of them raising a raw unique_violation error.
--
-- That guard was silently dropped when submit_sale was rewritten for
-- the vendeur product-scope feature (migration_v67) and never
-- restored in any later rewrite (v78/v81/v86/v93/v96/v107) — the
-- current function only has the pre-check (SELECT ... WHERE
-- idempotency_key = ...) with no fallback if two callers both pass
-- that check before either has inserted. This restores the original
-- v52 protection on top of the current (v107) function body, with no
-- other behavior changes.
-- ============================================================

CREATE OR REPLACE FUNCTION public.submit_sale(
  p_business_id      uuid,
  p_seller_id        uuid,
  p_customer_name    text      DEFAULT NULL,
  p_sale_date        date      DEFAULT CURRENT_DATE,
  p_total_amount     numeric   DEFAULT 0,
  p_discount_amount  numeric   DEFAULT 0,
  p_is_credit        boolean   DEFAULT false,
  p_cart             jsonb     DEFAULT '[]',
  p_pay_method       text      DEFAULT NULL,
  p_pay_amount       numeric   DEFAULT NULL,
  p_pay_ref          text      DEFAULT NULL,
  p_idempotency_key  uuid      DEFAULT NULL,
  p_client_id        uuid      DEFAULT NULL,
  p_due_date         date      DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order_id       uuid;
  v_item           jsonb;
  v_membership_id  uuid;
  v_has_scope      boolean;
  v_cost_price     bigint;
  v_unit_price_eff bigint;
  v_line_profit    bigint;
  v_investor       RECORD;
  v_rows_affected  integer;
BEGIN
  IF get_role(p_business_id) NOT IN ('administrateur', 'manager', 'vendeur') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF get_role(p_business_id) = 'vendeur' AND p_seller_id != auth.uid() THEN
    RAISE EXCEPTION 'Un vendeur ne peut enregistrer que ses propres ventes' USING ERRCODE = 'P0001';
  END IF;

  IF get_role(p_business_id) = 'vendeur' THEN
    SELECT id INTO v_membership_id
    FROM memberships
    WHERE user_id = auth.uid() AND business_id = p_business_id;

    SELECT EXISTS(
      SELECT 1 FROM membership_product_scope WHERE membership_id = v_membership_id
    ) INTO v_has_scope;

    IF v_has_scope THEN
      PERFORM 1
      FROM jsonb_to_recordset(p_cart) AS c(product_id uuid)
      WHERE c.product_id NOT IN (
        SELECT product_id FROM membership_product_scope
        WHERE membership_id = v_membership_id
      );
      IF FOUND THEN
        RAISE EXCEPTION 'Produit non autorisé : ce vendeur ne peut pas vendre ce produit' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_order_id
    FROM sale_orders
    WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN RETURN v_order_id; END IF;
  END IF;

  v_order_id := gen_random_uuid();

  BEGIN
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
  EXCEPTION WHEN unique_violation THEN
    -- Race: another concurrent request with the same key committed first.
    -- Return its order ID so the client gets an idempotent response instead
    -- of a raw duplicate-key error.
    IF p_idempotency_key IS NOT NULL THEN
      SELECT id INTO v_order_id
      FROM sale_orders
      WHERE idempotency_key = p_idempotency_key;
      IF FOUND THEN RETURN v_order_id; END IF;
    END IF;
    RAISE;
  END;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_cart) LOOP
    -- Cost snapshot: variant first, fall back to parent product
    v_cost_price := NULL;
    IF nullif(v_item->>'variant_id', '') IS NOT NULL THEN
      SELECT cost_price INTO v_cost_price
      FROM product_variants
      WHERE id = nullif(v_item->>'variant_id', '')::uuid;
    END IF;
    IF v_cost_price IS NULL THEN
      SELECT cost_price INTO v_cost_price
      FROM products
      WHERE id = (v_item->>'product_id')::uuid;
    END IF;

    INSERT INTO so_lines (
      id, order_id, product_id, product_name,
      qty, unit_price, is_bulk,
      variant_id, variant_name,
      cost_price_at_sale
    ) VALUES (
      gen_random_uuid(), v_order_id,
      (v_item->>'product_id')::uuid,
      v_item->>'product_name',
      (v_item->>'qty')::numeric,
      (v_item->>'unit_price')::numeric,
      coalesce((v_item->>'is_bulk')::boolean, false),
      nullif(v_item->>'variant_id', '')::uuid,
      nullif(v_item->>'variant_name', ''),
      v_cost_price
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

    IF nullif(v_item->>'variant_id', '') IS NOT NULL THEN
      -- Variant product: guard is on product_variants (parent products.stock_qty
      -- is always 0 for variant parents so no meaningful guard there).
      UPDATE products
      SET stock_qty = GREATEST(0, stock_qty - (v_item->>'qty')::numeric)
      WHERE id = (v_item->>'product_id')::uuid;

      UPDATE product_variants
      SET stock_qty = stock_qty - (v_item->>'qty')::numeric
      WHERE id     = nullif(v_item->>'variant_id', '')::uuid
        AND stock_qty >= (v_item->>'qty')::numeric;

      GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
      IF v_rows_affected = 0 THEN
        RAISE EXCEPTION 'Stock insuffisant : %',
          coalesce(nullif(v_item->>'variant_name', ''), v_item->>'product_name', 'Produit inconnu')
          USING ERRCODE = 'P0001';
      END IF;
    ELSE
      -- Plain product: guard is on products.
      UPDATE products
      SET stock_qty = stock_qty - (v_item->>'qty')::numeric
      WHERE id      = (v_item->>'product_id')::uuid
        AND stock_qty >= (v_item->>'qty')::numeric;

      GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
      IF v_rows_affected = 0 THEN
        RAISE EXCEPTION 'Stock insuffisant : %',
          coalesce(v_item->>'product_name', 'Produit inconnu')
          USING ERRCODE = 'P0001';
      END IF;
    END IF;

    -- Investor profit accumulation: unit_price is now always the real price charged.
    v_cost_price := NULL;
    IF nullif(v_item->>'variant_id', '') IS NOT NULL THEN
      SELECT cost_price INTO v_cost_price
      FROM product_variants
      WHERE id = nullif(v_item->>'variant_id', '')::uuid;
    END IF;
    IF v_cost_price IS NULL THEN
      SELECT cost_price INTO v_cost_price
      FROM products
      WHERE id = (v_item->>'product_id')::uuid;
    END IF;

    v_unit_price_eff := (v_item->>'unit_price')::bigint;

    v_line_profit := GREATEST(0,
      (v_unit_price_eff - coalesce(v_cost_price, 0))
      * (v_item->>'qty')::bigint
    );

    IF v_line_profit > 0 THEN
      FOR v_investor IN
        SELECT m.user_id, mps.profit_share
        FROM membership_product_scope mps
        JOIN memberships m ON m.id = mps.membership_id
        WHERE mps.product_id  = (v_item->>'product_id')::uuid
          AND m.business_id   = p_business_id
          AND m.role          = 'investisseur'
          AND mps.profit_share > 0
      LOOP
        INSERT INTO investor_balance (business_id, investor_id, balance, updated_at)
        VALUES (
          p_business_id,
          v_investor.user_id,
          ROUND(v_line_profit * v_investor.profit_share / 100.0)::bigint,
          now()
        )
        ON CONFLICT (business_id, investor_id) DO UPDATE
          SET balance    = investor_balance.balance
                         + ROUND(v_line_profit * v_investor.profit_share / 100.0)::bigint,
              updated_at = now();
      END LOOP;
    END IF;
  END LOOP;

  RETURN v_order_id;
END;
$$;
