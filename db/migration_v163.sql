-- ============================================================
-- Patron — Migration v163
-- Run in Supabase SQL Editor AFTER migration_v162
--
-- Second-action reminder ("Segment B" of the post-24h retention map — see
-- session review notes / CLAUDE.md). Targets a business that took exactly
-- one of the three activation actions (product, sale, or debt) and then
-- went quiet. This is the highest-leverage segment of the whole post-24h
-- window: they've already proven they can use the app — the barrier now is
-- a missing trigger to come back, not understanding how.
--
-- Classification is deliberately sale-first, product-fallback — not
-- arbitrary, and found by tracing what each real action-path actually
-- writes before writing this query:
--   - submit_carnet_debt() (the "Crédit rapide" quick-debt flow) creates a
--     hidden is_system product ("Solde reporté") as a side effect, on top
--     of the credit sale_orders row.
--   - "Vente rapide" (the fork's quick-sale flow) creates a REAL, visible
--     product (cloned from what was sold) on top of the cash sale_orders
--     row.
-- So a business whose one real action was "made a sale" would otherwise be
-- miscounted as two actions if products were counted first (one product +
-- one sale). Checking for a sale FIRST, and only falling back to "product
-- only" when zero sales exist at all, sidesteps this without needing a
-- special-case flag to distinguish "real" from "side-effect" products —
-- the debt case is already covered separately by the is_system exclusion.

ALTER TABLE businesses ADD COLUMN second_action_nudge_sent_at timestamptz;

-- min: hours since their one action before nudging. max: stop trying past
-- this many days — a business whose only action was months ago doesn't
-- belong in a "just getting started" message anymore.
INSERT INTO app_config (key, value) VALUES
  ('second_action_nudge_hours', 48),
  ('second_action_nudge_max_days', 14)
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION get_and_mark_second_action_reminders()
RETURNS TABLE (business_id uuid, action_type text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_min_hours int;
  v_max_days int;
BEGIN
  SELECT value INTO v_min_hours FROM app_config WHERE key = 'second_action_nudge_hours';
  SELECT value INTO v_max_days FROM app_config WHERE key = 'second_action_nudge_max_days';

  RETURN QUERY
  WITH biz_counts AS (
    SELECT
      b.id AS biz_id,
      (SELECT count(*) FROM sale_orders so WHERE so.business_id = b.id AND so.status <> 'annule') AS sale_count,
      (SELECT count(*) FROM products p WHERE p.business_id = b.id AND p.is_system = false) AS product_count
    FROM businesses b
    WHERE b.second_action_nudge_sent_at IS NULL
  ),
  one_sale AS (
    SELECT bc.biz_id, so.status AS order_status, so.created_at AS action_at
    FROM biz_counts bc
    JOIN LATERAL (
      SELECT so2.status, so2.created_at
      FROM sale_orders so2
      WHERE so2.business_id = bc.biz_id AND so2.status <> 'annule'
      LIMIT 1
    ) so ON true
    WHERE bc.sale_count = 1 AND bc.product_count <= 1
  ),
  one_product AS (
    SELECT bc.biz_id, p.created_at AS action_at
    FROM biz_counts bc
    JOIN LATERAL (
      SELECT p2.created_at
      FROM products p2
      WHERE p2.business_id = bc.biz_id AND p2.is_system = false
      LIMIT 1
    ) p ON true
    WHERE bc.sale_count = 0 AND bc.product_count = 1
  ),
  due_all AS (
    SELECT biz_id, (CASE WHEN order_status = 'credit' THEN 'debt' ELSE 'sale' END) AS a_type
    FROM one_sale
    WHERE now() - action_at >= (v_min_hours || ' hours')::interval
      AND now() - action_at <= (v_max_days || ' days')::interval
    UNION ALL
    SELECT biz_id, 'product' AS a_type
    FROM one_product
    WHERE now() - action_at >= (v_min_hours || ' hours')::interval
      AND now() - action_at <= (v_max_days || ' days')::interval
  ),
  marked AS (
    UPDATE businesses SET second_action_nudge_sent_at = now()
    WHERE id IN (SELECT due_all.biz_id FROM due_all)
    RETURNING id AS biz_id
  )
  SELECT marked.biz_id, due_all.a_type
  FROM marked
  JOIN due_all ON due_all.biz_id = marked.biz_id;
END;
$$;

-- REVOKE ... FROM PUBLIC alone is not enough — see migration_v137.sql for
-- why anon/authenticated need an explicit revoke too on this Supabase stack.
REVOKE EXECUTE ON FUNCTION get_and_mark_second_action_reminders() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_and_mark_second_action_reminders() TO service_role;
