-- ============================================================
-- Patron — Migration v93
-- Run in Supabase SQL Editor AFTER migration_v92
--
-- Problem: when a merchant types a payment amount higher than
-- the catalog price at checkout (overrideTotalAmount), the app
-- stores the actual cash in sale_orders.total_amount but leaves
-- so_lines.unit_price at the catalog price. get_product_stats
-- therefore understates revenue and profit for those merchants.
--
-- Fix:
--   1. Add so_lines.unit_price_paid BIGINT (nullable) — stores
--      the actual per-unit price when it differs from catalog.
--   2. submit_sale reads unit_price_paid from the cart JSON and
--      inserts it; also uses it for investor profit accumulation.
--   3. get_product_stats uses COALESCE(unit_price_paid, unit_price)
--      for revenue so actual-price sales are reflected correctly.
-- ============================================================

-- ─── 1. Add column ───────────────────────────────────────────
ALTER TABLE so_lines
  ADD COLUMN IF NOT EXISTS unit_price_paid BIGINT;

-- ─── 2. Recreate submit_sale ──────────────────────────────────
CREATE OR REPLACE FUNCTION submit_sale(
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
      qty, unit_price, unit_price_paid, is_bulk,
      variant_id, variant_name,
      cost_price_at_sale
    ) VALUES (
      gen_random_uuid(), v_order_id,
      (v_item->>'product_id')::uuid,
      v_item->>'product_name',
      (v_item->>'qty')::numeric,
      (v_item->>'unit_price')::numeric,
      nullif(v_item->>'unit_price_paid', '')::bigint,
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

    UPDATE products
    SET stock_qty = GREATEST(0, stock_qty - (v_item->>'qty')::numeric)
    WHERE id = (v_item->>'product_id')::uuid;

    IF nullif(v_item->>'variant_id', '') IS NOT NULL THEN
      UPDATE product_variants
      SET stock_qty = GREATEST(0, stock_qty - (v_item->>'qty')::numeric)
      WHERE id = nullif(v_item->>'variant_id', '')::uuid;
    END IF;

    -- Investor profit: use actual unit price paid when available
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

    v_unit_price_eff := COALESCE(
      nullif(v_item->>'unit_price_paid', '')::bigint,
      (v_item->>'unit_price')::bigint
    );

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

-- ─── 3. Recreate get_product_stats ───────────────────────────
CREATE OR REPLACE FUNCTION get_product_stats(
  p_product_id  uuid,
  p_business_id uuid,
  p_since       timestamptz DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cost_price      bigint;
  v_revenue         bigint;
  v_capital         bigint;
  v_qty_lost        bigint;
  v_linked_expenses bigint;
BEGIN
  IF NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé';
  END IF;

  SELECT cost_price INTO v_cost_price
  FROM products
  WHERE id = p_product_id AND business_id = p_business_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Produit introuvable';
  END IF;

  -- Revenue: use actual price paid when available, fall back to catalog unit_price
  SELECT COALESCE(SUM(COALESCE(sl.unit_price_paid, sl.unit_price) * sl.qty), 0)
  INTO v_revenue
  FROM so_lines sl
  JOIN sale_orders so ON so.id = sl.order_id
  WHERE sl.product_id = p_product_id
    AND so.business_id = p_business_id
    AND so.status != 'annule'
    AND (p_since IS NULL OR so.created_at >= p_since);

  -- Capital (COGS): snapshotted cost, fall back to variant then product cost
  SELECT COALESCE(SUM(
    sl.qty * COALESCE(sl.cost_price_at_sale, pv.cost_price, v_cost_price)
  ), 0)
  INTO v_capital
  FROM so_lines sl
  JOIN sale_orders so ON so.id = sl.order_id
  LEFT JOIN product_variants pv ON pv.id = sl.variant_id
  WHERE sl.product_id = p_product_id
    AND so.business_id = p_business_id
    AND so.status != 'annule'
    AND (p_since IS NULL OR so.created_at >= p_since);

  -- Losses
  SELECT COALESCE(SUM(qty), 0)
  INTO v_qty_lost
  FROM stock_moves
  WHERE product_id = p_product_id
    AND business_id = p_business_id
    AND type = 'perte'
    AND (p_since IS NULL OR created_at >= p_since);

  v_capital := v_capital + v_qty_lost * v_cost_price;

  -- Linked approved expenses
  SELECT COALESCE(SUM(amount), 0)
  INTO v_linked_expenses
  FROM expenses
  WHERE product_id   = p_product_id
    AND business_id  = p_business_id
    AND status       = 'approuve'
    AND (p_since IS NULL OR date >= p_since::date);

  RETURN json_build_object(
    'revenue',          v_revenue,
    'capital',          v_capital,
    'linked_expenses',  v_linked_expenses,
    'profit',           v_revenue - v_capital - v_linked_expenses
  );
END;
$$;

GRANT EXECUTE ON FUNCTION submit_sale(uuid,uuid,text,date,numeric,numeric,boolean,jsonb,text,numeric,text,uuid,uuid,date) TO authenticated;
GRANT EXECUTE ON FUNCTION get_product_stats(uuid, uuid, timestamptz) TO authenticated;
