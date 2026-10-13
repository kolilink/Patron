-- migration_v245: a queued sale is GROUND TRUTH — stock never refuses it.
--
-- On device: a credit sale made before the stock guard existed (3,000 GNF at 0 stock) drained under submit_sale's
-- `stock_qty >= qty` guard and was refused ("Stock insuffisant"), while the client's carnet kept showing the debt
-- → books did not match reality. The stock count is an ESTIMATE the vendor keeps by hand; a sale that already
-- happened is a FACT. At drain time insufficient stock therefore never raises: the sale is recorded in full
-- (lines, payment, stock_moves = what really left), stock is floored at 0, and the product is flagged
-- (products.needs_stock_review) so the owner can recount. Only genuine validation errors (invalid qty, foreign
-- product, discount/overpay, role) still refuse. submit_sale is one RPC = one transaction, so sale + payment +
-- lines + stock effects succeed or fail together; the client side never shows a refused sale in any balance.
-- Because stock_moves keeps the real quantity while stock_qty is floored, reconciliation's stock checks may report
-- a difference for exactly these flagged products until the owner adjusts stock (which clears the flag).
-- Signature unchanged → plain CREATE OR REPLACE (no overload risk).

ALTER TABLE products ADD COLUMN IF NOT EXISTS needs_stock_review boolean NOT NULL DEFAULT false;
ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_review_at timestamptz;

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
  v_scope_all      boolean;
  v_has_scope      boolean;
  v_cost_price     bigint;
  v_unit_price_eff bigint;
  v_line_profit    bigint;
  v_investor       RECORD;
  v_computed_total bigint;
BEGIN
  IF get_role(p_business_id) IS NULL OR get_role(p_business_id) NOT IN ('administrateur', 'manager', 'vendeur') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF get_role(p_business_id) = 'vendeur' AND p_seller_id != auth.uid() THEN
    RAISE EXCEPTION 'Un vendeur ne peut enregistrer que ses propres ventes' USING ERRCODE = 'P0001';
  END IF;

  -- Fix (2): vendeur product scope, keyed on the scope_all_products flag
  -- (migration_v80's original logic). scope_all_products=false + no assigned
  -- rows = the vendeur can sell NOTHING, not everything.
  IF get_role(p_business_id) = 'vendeur' THEN
    SELECT id, scope_all_products INTO v_membership_id, v_scope_all
    FROM memberships
    WHERE user_id = auth.uid() AND business_id = p_business_id;

    IF NOT v_scope_all THEN
      SELECT EXISTS(
        SELECT 1 FROM membership_product_scope WHERE membership_id = v_membership_id
      ) INTO v_has_scope;

      IF NOT v_has_scope THEN
        RAISE EXCEPTION 'Vous n''avez pas encore de produits assignés. Contactez votre gérant.' USING ERRCODE = 'P0001';
      END IF;

      PERFORM 1
      FROM jsonb_to_recordset(p_cart) AS c(product_id uuid)
      WHERE c.product_id NOT IN (
        SELECT product_id FROM membership_product_scope
        WHERE membership_id = v_membership_id
      );
      IF FOUND THEN
        RAISE EXCEPTION 'Produit non autorisé : vous ne pouvez pas vendre ce produit' USING ERRCODE = 'P0001';
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

  -- discount guard, mirroring edit_sale's semantics. A negative discount is
  -- nonsense; a discount ≥ total would store a negative-owed debt shown as
  -- «Réglé ✓».
  IF COALESCE(p_discount_amount, 0) < 0 THEN
    RAISE EXCEPTION 'La remise ne peut pas être négative' USING ERRCODE = 'P0001';
  END IF;
  IF COALESCE(p_discount_amount, 0) > 0 AND COALESCE(p_discount_amount, 0) >= v_computed_total THEN
    RAISE EXCEPTION 'La remise doit être inférieure au total' USING ERRCODE = 'P0001';
  END IF;

  -- overpay guard. Never let a payment exceed the remaining balance owed
  -- (total − discount).
  IF p_pay_amount IS NOT NULL
     AND p_pay_amount > (v_computed_total - COALESCE(p_discount_amount, 0)) THEN
    RAISE EXCEPTION 'Le montant dépasse le solde restant dû' USING ERRCODE = 'P0001';
  END IF;

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
    -- guarantees ownership.
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
    INSERT INTO payments (id, order_id, customer_name, business_id, method, amount, date, ref_external, seller_id)
    VALUES (
      gen_random_uuid(), v_order_id,
      nullif(trim(coalesce(p_customer_name, '')), ''),
      p_business_id, p_pay_method, p_pay_amount, p_sale_date,
      nullif(trim(coalesce(p_pay_ref, '')), ''),
      auth.uid()
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

    -- The sale is ground truth; the stock count is the estimate. A sale is NEVER refused for stock: apply it,
    -- floor stock at 0, and flag the product for review ("stock à vérifier"). Flag first (it reads the
    -- pre-sale quantity), then decrement.
    IF nullif(v_item->>'variant_id', '') IS NOT NULL THEN
      -- Variant products: the parent's own stock_qty is always 0; the shortfall lives on the variant,
      -- the flag lives on the parent product (what Gérer lists).
      UPDATE products
      SET needs_stock_review = needs_stock_review OR short.is_short,
          stock_review_at = CASE WHEN short.is_short THEN now() ELSE stock_review_at END,
          stock_qty = GREATEST(0, stock_qty - (v_item->>'qty')::numeric)
      FROM (
        SELECT EXISTS (
          SELECT 1 FROM product_variants pv
          WHERE pv.id = nullif(v_item->>'variant_id', '')::uuid
            AND pv.business_id = p_business_id
            AND pv.stock_qty < (v_item->>'qty')::numeric
        ) AS is_short
      ) short
      WHERE products.id = (v_item->>'product_id')::uuid AND products.business_id = p_business_id;

      UPDATE product_variants
      SET stock_qty = GREATEST(0, stock_qty - (v_item->>'qty')::numeric)
      WHERE id = nullif(v_item->>'variant_id', '')::uuid
        AND business_id = p_business_id;
    ELSE
      UPDATE products
      SET needs_stock_review = needs_stock_review OR stock_qty < (v_item->>'qty')::numeric,
          stock_review_at = CASE WHEN stock_qty < (v_item->>'qty')::numeric THEN now() ELSE stock_review_at END,
          stock_qty = GREATEST(0, stock_qty - (v_item->>'qty')::numeric)
      WHERE id = (v_item->>'product_id')::uuid
        AND business_id = p_business_id;
    END IF;

    -- Investor profit accumulation.
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

GRANT EXECUTE ON FUNCTION public.submit_sale(uuid, uuid, text, date, numeric, numeric, boolean, jsonb, text, numeric, text, uuid, uuid, date) TO authenticated;
