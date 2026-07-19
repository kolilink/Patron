-- ============================================================
-- Patron — Migration v152
-- Run in Supabase SQL Editor AFTER migration_v151
--
-- Fix: get_product_stats() computed revenue/capital with
-- `so.status != 'annule'` — i.e. every non-cancelled order,
-- including 'brouillon' and 'confirme' orders that were never
-- actually paid. Every other revenue calculation in this codebase
-- (get_reports_snapshot, get_best_sellers, get_financial_snapshot)
-- standardizes on `so.status IN ('paye', 'credit')` — real, closed
-- sales only. That mismatch meant a product's lifetime revenue
-- from get_product_stats (surfaced to merchants via Alpha's
-- chercher_produit tool, supabase/functions/alpha-chat/index.ts)
-- could exceed the business's own lifetime revenue total from
-- get_reports_snapshot — an impossible number, confirmed live: a
-- single-product business's chercher_produit lookup returned
-- 42,085,000 GNF lifetime revenue for that product while the same
-- conversation's own "depuis_le_debut" business-wide total (same
-- get_reports_snapshot lifetime call) was only 38,130,002 GNF.
-- Alpha stated the number faithfully — it was the RPC's own status
-- filter that was wrong, not a model hallucination.
--
-- Fixes both the revenue SELECT and the capital/COGS SELECT (the
-- only two queries in this function that filter on so.status) to
-- match the paye/credit-only convention used everywhere else.
-- Losses (stock_moves) and linked expenses are unaffected — neither
-- references sale_orders.status.
-- ============================================================

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

  -- Revenue: real, closed sales only (v152) — matches
  -- get_reports_snapshot / get_best_sellers, not "everything not cancelled".
  SELECT COALESCE(SUM(sl.unit_price * sl.qty), 0)
  INTO v_revenue
  FROM so_lines sl
  JOIN sale_orders so ON so.id = sl.order_id
  WHERE sl.product_id = p_product_id
    AND so.business_id = p_business_id
    AND so.status IN ('paye', 'credit')
    AND (p_since IS NULL OR so.created_at >= p_since);

  -- Capital (COGS): same status fix — snapshotted cost, fall back to
  -- variant then product cost.
  SELECT COALESCE(SUM(
    sl.qty * COALESCE(sl.cost_price_at_sale, pv.cost_price, v_cost_price)
  ), 0)
  INTO v_capital
  FROM so_lines sl
  JOIN sale_orders so ON so.id = sl.order_id
  LEFT JOIN product_variants pv ON pv.id = sl.variant_id
  WHERE sl.product_id = p_product_id
    AND so.business_id = p_business_id
    AND so.status IN ('paye', 'credit')
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

GRANT EXECUTE ON FUNCTION get_product_stats(uuid, uuid, timestamptz) TO authenticated;
