-- ============================================================
-- Patron — Migration v87
-- Run in Supabase SQL Editor AFTER migration_v86
--
-- get_stock_velocity: returns days of stock remaining per
-- sellable unit (plain product or variant), based on a
-- 90-day weighted sales velocity:
--   velocity = qty_7d/7 × 0.5 + qty_30d/30 × 0.3 + qty_90d/90 × 0.2
--
-- days_remaining:
--   -1   = out of stock (stock_qty <= 0)
--   NULL = no sales in 90 days (can't estimate)
--   0+   = estimated days, capped at 999
--
-- Uses sale_orders.created_at (when stock was depleted) not
-- paid_at (cash flow), since we're measuring depletion rate.
-- Cancelled and draft orders excluded.
-- ============================================================

CREATE OR REPLACE FUNCTION get_stock_velocity(p_business_id uuid)
RETURNS TABLE(
  item_id        uuid,
  item_name      text,
  stock_qty      numeric,
  days_remaining integer
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
BEGIN
  IF NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé';
  END IF;

  RETURN QUERY

  WITH plain_velocity AS (
    SELECT
      sl.product_id,
      SUM(sl.qty) FILTER (WHERE so.created_at >= now() - interval '7 days')  AS qty_7d,
      SUM(sl.qty) FILTER (WHERE so.created_at >= now() - interval '30 days') AS qty_30d,
      SUM(sl.qty) FILTER (WHERE so.created_at >= now() - interval '90 days') AS qty_90d
    FROM so_lines sl
    JOIN sale_orders so ON so.id = sl.order_id
    WHERE so.business_id    = p_business_id
      AND so.status         NOT IN ('annule', 'brouillon')
      AND so.created_at     >= now() - interval '90 days'
      AND sl.variant_id     IS NULL
    GROUP BY sl.product_id
  ),
  variant_velocity AS (
    SELECT
      sl.variant_id,
      SUM(sl.qty) FILTER (WHERE so.created_at >= now() - interval '7 days')  AS qty_7d,
      SUM(sl.qty) FILTER (WHERE so.created_at >= now() - interval '30 days') AS qty_30d,
      SUM(sl.qty) FILTER (WHERE so.created_at >= now() - interval '90 days') AS qty_90d
    FROM so_lines sl
    JOIN sale_orders so ON so.id = sl.order_id
    WHERE so.business_id    = p_business_id
      AND so.status         NOT IN ('annule', 'brouillon')
      AND so.created_at     >= now() - interval '90 days'
      AND sl.variant_id     IS NOT NULL
    GROUP BY sl.variant_id
  )

  -- Plain products
  SELECT
    p.id,
    p.name,
    p.stock_qty,
    CASE
      WHEN p.stock_qty <= 0 THEN -1
      WHEN COALESCE(pv.qty_90d, 0) = 0 THEN NULL
      ELSE LEAST(999, ROUND(
        p.stock_qty /
        NULLIF(
          COALESCE(pv.qty_7d,  0) / 7.0  * 0.5 +
          COALESCE(pv.qty_30d, 0) / 30.0 * 0.3 +
          COALESCE(pv.qty_90d, 0) / 90.0 * 0.2,
          0
        )
      )::integer)
    END
  FROM products p
  LEFT JOIN plain_velocity pv ON pv.product_id = p.id
  WHERE p.business_id = p_business_id
    AND NOT p.archived
    AND NOT p.has_variants

  UNION ALL

  -- Variants
  SELECT
    pvar.id,
    p.name || ' · ' || pvar.name,
    pvar.stock_qty,
    CASE
      WHEN pvar.stock_qty <= 0 THEN -1
      WHEN COALESCE(vv.qty_90d, 0) = 0 THEN NULL
      ELSE LEAST(999, ROUND(
        pvar.stock_qty /
        NULLIF(
          COALESCE(vv.qty_7d,  0) / 7.0  * 0.5 +
          COALESCE(vv.qty_30d, 0) / 30.0 * 0.3 +
          COALESCE(vv.qty_90d, 0) / 90.0 * 0.2,
          0
        )
      )::integer)
    END
  FROM product_variants pvar
  JOIN products p ON p.id = pvar.product_id
  LEFT JOIN variant_velocity vv ON vv.variant_id = pvar.id
  WHERE p.business_id = p_business_id
    AND NOT p.archived
    AND NOT pvar.archived

  ORDER BY
    CASE WHEN days_remaining = -1 THEN 0 ELSE 1 END,
    days_remaining ASC NULLS LAST;

END;
$$;

GRANT EXECUTE ON FUNCTION get_stock_velocity(uuid) TO authenticated;
