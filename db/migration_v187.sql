-- ============================================================
-- Patron — Migration v187
-- Run in Supabase SQL Editor AFTER migration_v186
--
-- SECURITY FIX — checklist 1.8 fuzz/edge-case pass on submit_sale(), the
-- single highest-volume write in the app. Confirmed live against a real
-- Postgres instance (not just read from the code) before writing this fix —
-- see __tests__/integration/submit-sale-edge-cases.integration.test.ts.
-- Two real, serious bugs found:
--
-- 1. NEGATIVE QUANTITY silently ADDED stock instead of being rejected. The
--    guard on both stock-deduction UPDATEs was `stock_qty >= qty` — with a
--    negative qty that condition is trivially true for any non-negative
--    stock_qty, so it never blocked anything, and `stock_qty - (-5)` is
--    `stock_qty + 5`. Confirmed empirically: a cart with qty: -5 against a
--    product starting at stock_qty 10 left it at 15, while still recording
--    a real (negative-total) sale.
--
-- 2. CROSS-BUSINESS product_id let a member of business A silently deduct
--    stock from a product belonging to business B. Neither the cost_price
--    lookups nor the stock-deduction UPDATEs anywhere in this function ever
--    filtered by business_id — only `WHERE id = product_id`. Since this
--    function is SECURITY DEFINER, RLS provides zero protection here on its
--    own; the function's own body is the only thing that can enforce
--    tenant isolation, and it didn't. Confirmed empirically: business B's
--    own submit_sale call, referencing business A's product_id, deducted
--    10 units from business A's stock (50 → 40) with no error.
--
-- Fix, in two layers:
--   (a) A new validation pass over the whole cart, BEFORE anything is
--       inserted: cart must be non-empty, every qty must be a positive
--       number, and every product_id (and variant_id, if present) must
--       actually belong to p_business_id. Fails fast with nothing to roll
--       back, rather than catching it mid-way through side effects.
--   (b) Defense-in-depth: business_id = p_business_id added directly to
--       both cost_price lookups and both stock-deduction UPDATEs too, so a
--       future edit that weakens or removes (a) doesn't silently reopen
--       this on its own.
--
-- Zero-quantity and empty-cart are folded into the same validation pass —
-- neither was a security bug (no stock/tenant impact), just a data-quality
-- gap (a meaningless sale line, or a $0 phantom order), but the same "fail
-- before inserting anything" check closes both for free.
--
-- Confirmed SAFE, no change needed (also verified empirically, not
-- assumed): duplicate lines for the same product correctly sum their
-- deductions; a cart line missing unit_price entirely is already rejected
-- cleanly by so_lines' own NOT NULL constraint, rolled back with no
-- orphaned sale_orders row; a product_id that doesn't exist at all was
-- already caught by the existing "Stock insuffisant" guard (a
-- WHERE id = ... match on zero rows), also rolled back cleanly. Per-line
-- unit_price stays fully trusted, unchanged — negotiated pricing above/
-- below catalog is still an intentional, pre-existing feature.
--
-- No signature change — CREATE OR REPLACE is safe here.
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
  v_computed_total bigint;
BEGIN
  IF get_role(p_business_id) IS NULL OR get_role(p_business_id) NOT IN ('administrateur', 'manager', 'vendeur') THEN
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

  -- Validate the whole cart BEFORE inserting anything — fail fast, nothing
  -- to roll back. Every qty must be a real positive number, and every
  -- product/variant must actually belong to this business (SECURITY
  -- DEFINER means RLS never enforces this on its own — see migration note).
  IF p_cart IS NULL OR jsonb_array_length(p_cart) = 0 THEN
    RAISE EXCEPTION 'Ajoutez au moins un article' USING ERRCODE = 'P0001';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_cart) LOOP
    IF (v_item->>'qty')::numeric IS NULL OR (v_item->>'qty')::numeric <= 0 THEN
      RAISE EXCEPTION 'Quantité invalide pour "%"', coalesce(v_item->>'product_name', 'un article')
        USING ERRCODE = 'P0001';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM products
      WHERE id = (v_item->>'product_id')::uuid AND business_id = p_business_id
    ) THEN
      RAISE EXCEPTION 'Produit introuvable' USING ERRCODE = 'P0001';
    END IF;

    IF nullif(v_item->>'variant_id', '') IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM product_variants
      WHERE id = nullif(v_item->>'variant_id', '')::uuid AND business_id = p_business_id
    ) THEN
      RAISE EXCEPTION 'Produit introuvable' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  v_order_id := gen_random_uuid();

  -- Never trust the client's own total: derive it from the same cart it
  -- also supplies, before that cart's lines are even inserted. Line-level
  -- unit_price stays fully trusted (negotiated pricing is intentional) —
  -- only the AGGREGATE total is no longer a separately-asserted number.
  SELECT COALESCE(SUM((item->>'qty')::numeric * (item->>'unit_price')::numeric), 0)::bigint
  INTO v_computed_total
  FROM jsonb_array_elements(p_cart) AS item;

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
      v_computed_total, p_discount_amount,
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
    -- Cost snapshot: variant first, fall back to parent product. business_id
    -- filter is defense-in-depth — the validation pass above already
    -- guarantees ownership, this just means a future edit that weakens that
    -- pass can't silently reopen cross-business cost_price exposure either.
    v_cost_price := NULL;
    IF nullif(v_item->>'variant_id', '') IS NOT NULL THEN
      SELECT cost_price INTO v_cost_price
      FROM product_variants
      WHERE id = nullif(v_item->>'variant_id', '')::uuid AND business_id = p_business_id;
    END IF;
    IF v_cost_price IS NULL THEN
      SELECT cost_price INTO v_cost_price
      FROM products
      WHERE id = (v_item->>'product_id')::uuid AND business_id = p_business_id;
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
      -- business_id filter is defense-in-depth (see note above).
      UPDATE products
      SET stock_qty = GREATEST(0, stock_qty - (v_item->>'qty')::numeric)
      WHERE id = (v_item->>'product_id')::uuid AND business_id = p_business_id;

      UPDATE product_variants
      SET stock_qty = stock_qty - (v_item->>'qty')::numeric
      WHERE id     = nullif(v_item->>'variant_id', '')::uuid
        AND business_id = p_business_id
        AND stock_qty >= (v_item->>'qty')::numeric;

      GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
      IF v_rows_affected = 0 THEN
        RAISE EXCEPTION 'Stock insuffisant : %',
          coalesce(nullif(v_item->>'variant_name', ''), v_item->>'product_name', 'Produit inconnu')
          USING ERRCODE = 'P0001';
      END IF;
    ELSE
      -- Plain product: guard is on products. business_id filter is
      -- defense-in-depth (see note above).
      UPDATE products
      SET stock_qty = stock_qty - (v_item->>'qty')::numeric
      WHERE id      = (v_item->>'product_id')::uuid
        AND business_id = p_business_id
        AND stock_qty >= (v_item->>'qty')::numeric;

      GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
      IF v_rows_affected = 0 THEN
        RAISE EXCEPTION 'Stock insuffisant : %',
          coalesce(v_item->>'product_name', 'Produit inconnu')
          USING ERRCODE = 'P0001';
      END IF;
    END IF;

    -- Investor profit accumulation: unit_price is now always the real price
    -- charged. business_id filter is defense-in-depth (see note above).
    v_cost_price := NULL;
    IF nullif(v_item->>'variant_id', '') IS NOT NULL THEN
      SELECT cost_price INTO v_cost_price
      FROM product_variants
      WHERE id = nullif(v_item->>'variant_id', '')::uuid AND business_id = p_business_id;
    END IF;
    IF v_cost_price IS NULL THEN
      SELECT cost_price INTO v_cost_price
      FROM products
      WHERE id = (v_item->>'product_id')::uuid AND business_id = p_business_id;
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
