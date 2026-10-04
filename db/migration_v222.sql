-- ============================================================
-- Patron — Migration v222
-- Run in Supabase SQL Editor AFTER migration_v221
--
-- Fix: get_product_stats() returned an overstated "profit" for a
-- product whose sold lines have an UNKNOWN purchase cost. Since v221,
-- products.cost_price / product_variants.cost_price may be NULL, and
-- quick-sale "Vente rapide" lines always have cost_price_at_sale = NULL.
-- The old COGS select used
--   COALESCE(sl.cost_price_at_sale, pv.cost_price, v_cost_price)
-- which yields NULL for such a line, so SUM() silently dropped that
-- line's cost while the revenue select still counted its full revenue —
-- profit was inflated by exactly the unknown-cost lines' revenue.
--
-- This migration (a superset of the v160 body) keeps revenue always
-- correct, but returns `profit` as NULL whenever ANY sold line in the
-- period has an unresolvable cost, so the catalogue "Rentabilité" sheet
-- can render "—" instead of a fictitious margin. `capital` (Coût d'achat)
-- is unchanged: it is the sum of the KNOWN costs, the same posture as
-- get_period_report's v_cogs (v220).
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
  v_cost_price        bigint;
  v_revenue           bigint;
  v_capital           bigint;
  v_qty_lost          bigint;
  v_linked_expenses   bigint;
  v_has_unknown_cost  boolean;
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

  -- Unknown-cost flag (v222): any sold line in the period whose cost cannot
  -- be resolved to a real positive number makes the whole profit figure
  -- untrustworthy — return it as NULL (client shows "—"). This catches both
  -- (a) v221 NULL-cost products and (b) quick-sale "Vente rapide" lines,
  -- whose cost_price_at_sale is NULL and whose system placeholder has
  -- cost_price = 0 (a fake, never a real recorded purchase cost).
  SELECT EXISTS (
    SELECT 1
    FROM so_lines sl
    JOIN sale_orders so ON so.id = sl.order_id
    LEFT JOIN product_variants pv ON pv.id = sl.variant_id
    WHERE sl.product_id = p_product_id
      AND so.business_id = p_business_id
      AND so.status IN ('paye', 'credit')
      AND (p_since IS NULL OR so.created_at >= p_since)
      AND (
        COALESCE(sl.cost_price_at_sale, pv.cost_price, v_cost_price) IS NULL
        OR COALESCE(sl.cost_price_at_sale, pv.cost_price, v_cost_price) <= 0
      )
  )
  INTO v_has_unknown_cost;

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
    'profit',           CASE WHEN v_has_unknown_cost THEN NULL
                             ELSE v_revenue - v_capital - v_linked_expenses
                        END
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_product_stats(uuid, uuid, timestamptz) TO authenticated;
