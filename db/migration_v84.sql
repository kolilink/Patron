-- ============================================================
-- Patron — Migration v84
-- Run in Supabase SQL Editor AFTER migration_v83
--
-- Two changes:
--   1. Add optional product_id to expenses so an expense can be
--      attributed to a specific product (affects that product's
--      profit view in the catalogue).
--   2. Recreate get_product_stats to:
--        a. Use cost_price_at_sale snapshot (fixes same bug as
--           migration_v82 did for get_order_cogs — historical rows
--           fall back to current cost_price).
--        b. Subtract linked approved expenses from the product's
--           profit within the requested time window.
--        c. Return linkedExpenses in the JSON so the UI can show
--           it as a separate line item.
-- ============================================================

-- ─── 1. expenses.product_id ──────────────────────────────────────────────────

ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS product_id uuid REFERENCES products(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_expenses_product
  ON expenses (product_id)
  WHERE product_id IS NOT NULL;

-- ─── 2. Recreate get_product_stats ───────────────────────────────────────────

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

  -- Revenue: sum of unit_price × qty across all non-cancelled orders
  SELECT COALESCE(SUM(sl.unit_price * sl.qty), 0)
  INTO v_revenue
  FROM so_lines sl
  JOIN sale_orders so ON so.id = sl.order_id
  WHERE sl.product_id = p_product_id
    AND so.business_id = p_business_id
    AND so.status != 'annule'
    AND (p_since IS NULL OR so.created_at >= p_since);

  -- Capital (COGS): use snapshotted cost_price_at_sale when available,
  -- fall back to variant cost_price, then parent product cost_price.
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

  -- Linked approved expenses attributed to this product in the period
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

GRANT EXECUTE ON FUNCTION get_product_stats(uuid, uuid, timestamptz) TO authenticated;
