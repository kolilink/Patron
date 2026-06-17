-- migration v58: get_product_stats RPC
-- Returns revenue, capital (cost of sold + lost units), and profit for a product.
-- All monetary values are returned as BIGINT cents (÷100 before display).

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

  SELECT
    COALESCE(SUM(sl.unit_price * sl.qty), 0),
    COALESCE(SUM(sl.qty), 0)
  INTO v_revenue, v_qty_sold
  FROM so_lines sl
  JOIN sale_orders so ON so.id = sl.sale_order_id
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
