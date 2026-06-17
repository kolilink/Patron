-- migration v60: fix so_lines column name in v58 + v59 RPCs
--
-- Both get_product_stats (v58) and submit_carnet_debt (v59) were written with
-- the wrong join column: they used sl.sale_order_id / sale_order_id, but the
-- actual so_lines column is `order_id` (defined in schema.sql and v22).
--
-- submit_carnet_debt additionally referenced so_lines.cost_price which has
-- never existed on that table (cost_price lives on products, not so_lines).
--
-- This migration replaces both functions with corrected versions.
-- It is idempotent — safe to re-run.

-- ─── Fix 1: get_product_stats ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION get_product_stats(
  p_product_id uuid,
  p_business_id uuid,
  p_since timestamptz DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cost_price bigint;
  v_revenue    bigint;
  v_qty_sold   bigint;
  v_qty_lost   bigint;
  v_capital    bigint;
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

  -- v60 fix: join on sl.order_id (was incorrectly sl.sale_order_id in v58)
  SELECT
    COALESCE(SUM(sl.unit_price * sl.qty), 0),
    COALESCE(SUM(sl.qty), 0)
  INTO v_revenue, v_qty_sold
  FROM so_lines sl
  JOIN sale_orders so ON so.id = sl.order_id
  WHERE sl.product_id = p_product_id
    AND so.business_id = p_business_id
    AND so.status != 'annule'
    AND (p_since IS NULL OR so.created_at >= p_since);

  SELECT COALESCE(SUM(qty), 0)
  INTO v_qty_lost
  FROM stock_moves
  WHERE product_id = p_product_id
    AND business_id = p_business_id
    AND type = 'perte'
    AND (p_since IS NULL OR created_at >= p_since);

  v_capital := (v_qty_sold + v_qty_lost) * v_cost_price;

  RETURN json_build_object(
    'revenue', v_revenue,
    'capital', v_capital,
    'profit',  v_revenue - v_capital
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_product_stats(uuid, uuid, timestamptz) TO authenticated;


-- ─── Fix 2: submit_carnet_debt ────────────────────────────────────────────────

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

  -- v60 fix: use order_id (was sale_order_id in v59); removed cost_price which
  -- does not exist on so_lines (it lives on products only).
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
