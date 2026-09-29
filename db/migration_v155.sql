-- v155: Activation nudge engine — activation_nudge_1, activation_nudge_2,
-- second_action_reminder (copy/route already reserved in registry.ts).
--
-- "Signup" = businesses.created_at, "the vendor" = businesses.created_by
-- (the account that actually created the business — the one member
-- guaranteed to exist from minute one, same anchor migration_v120.sql's
-- create_business_with_membership already treats as the business owner).
-- A "capture" is any of: a real sale_orders row (status not in
-- ('brouillon','annule')), a credit sale (status = 'credit'), or a new
-- product row (products.created_at) — all three are cheap to read directly
-- off existing tables, no new event-log table needed for detection.
--
-- All three nudge types retire permanently 7 days after signup — the
-- `now() - b.created_at <= interval '7 days'` guard on every branch below,
-- not just a cron schedule cutoff, so a late-running cron can never fire a
-- stale nudge past that window.
CREATE TABLE IF NOT EXISTS activation_nudges_sent (
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  event_type  text NOT NULL CHECK (event_type IN ('activation_nudge_1', 'activation_nudge_2', 'second_action_reminder')),
  sent_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, event_type)
);

-- service_role only, no client RLS policy — same posture as
-- alpha_whatsapp_reminders_sent (migration_v143.sql) and every other
-- cron-only "have we already notified this" tracking table.
ALTER TABLE activation_nudges_sent ENABLE ROW LEVEL SECURITY;

-- get_and_mark_activation_nudges: atomically finds every business
-- qualifying for activation_nudge_1, activation_nudge_2, or
-- second_action_reminder right now, and marks each one sent in the same
-- statement so an overlapping cron run can never double-send — same shape
-- as get_and_mark_daily_digest_businesses (migration_v139.sql) and
-- get_and_mark_alpha_whatsapp_candidates (migration_v143.sql).
--
-- activation_nudge_1 fires once signup is 4-6h old with zero captures;
-- activation_nudge_2 fires once signup is >=24h old with zero captures
-- (both are one-shot per business via the PRIMARY KEY on
-- activation_nudges_sent, so a business that never captures anything just
-- never gets a 3rd/4th/etc. nudge of either kind).
-- second_action_reminder fires once the FIRST capture is >=24h old and no
-- SECOND capture exists yet, with action_type set to whichever type that
-- first capture was ('product' | 'debt' | 'sale' — matching
-- SECOND_ACTION_TITLES in dispatch-notification/index.ts).
CREATE OR REPLACE FUNCTION get_and_mark_activation_nudges()
RETURNS TABLE (business_id uuid, user_id uuid, event_type text, action_type text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH captures AS (
    SELECT so.business_id, so.created_at,
           CASE WHEN so.status = 'credit' THEN 'debt' ELSE 'sale' END AS action_type
    FROM sale_orders so
    WHERE so.status NOT IN ('brouillon', 'annule')
    UNION ALL
    SELECT p.business_id, p.created_at, 'product' AS action_type
    FROM products p
  ),
  ranked_captures AS (
    SELECT captures.business_id, captures.created_at, captures.action_type,
           row_number() OVER (PARTITION BY captures.business_id ORDER BY captures.created_at ASC) AS rn
    FROM captures
  ),
  first_capture AS (
    SELECT ranked_captures.business_id, ranked_captures.created_at AS first_at, ranked_captures.action_type
    FROM ranked_captures WHERE rn = 1
  ),
  has_second_capture AS (
    SELECT DISTINCT ranked_captures.business_id FROM ranked_captures WHERE rn = 2
  ),

  nudge1 AS (
    SELECT b.id AS business_id, b.created_by AS user_id,
           'activation_nudge_1'::text AS event_type, NULL::text AS action_type
    FROM businesses b
    WHERE now() - b.created_at BETWEEN interval '4 hours' AND interval '6 hours'
      AND now() - b.created_at <= interval '7 days'
      AND NOT EXISTS (SELECT 1 FROM first_capture fc WHERE fc.business_id = b.id)
      AND NOT EXISTS (
        SELECT 1 FROM activation_nudges_sent s
        WHERE s.business_id = b.id AND s.event_type = 'activation_nudge_1'
      )
  ),
  nudge2 AS (
    SELECT b.id AS business_id, b.created_by AS user_id,
           'activation_nudge_2'::text AS event_type, NULL::text AS action_type
    FROM businesses b
    WHERE now() - b.created_at >= interval '24 hours'
      AND now() - b.created_at <= interval '7 days'
      AND NOT EXISTS (SELECT 1 FROM first_capture fc WHERE fc.business_id = b.id)
      AND NOT EXISTS (
        SELECT 1 FROM activation_nudges_sent s
        WHERE s.business_id = b.id AND s.event_type = 'activation_nudge_2'
      )
  ),
  second_action AS (
    SELECT b.id AS business_id, b.created_by AS user_id,
           'second_action_reminder'::text AS event_type, fc.action_type
    FROM businesses b
    JOIN first_capture fc ON fc.business_id = b.id
    WHERE now() - fc.first_at >= interval '24 hours'
      AND now() - b.created_at <= interval '7 days'
      AND NOT EXISTS (SELECT 1 FROM has_second_capture hc WHERE hc.business_id = b.id)
      AND NOT EXISTS (
        SELECT 1 FROM activation_nudges_sent s
        WHERE s.business_id = b.id AND s.event_type = 'second_action_reminder'
      )
  ),
  candidates AS (
    SELECT * FROM nudge1
    UNION ALL SELECT * FROM nudge2
    UNION ALL SELECT * FROM second_action
  ),
  marked AS (
    INSERT INTO activation_nudges_sent AS ans (business_id, event_type)
    SELECT c.business_id, c.event_type FROM candidates c
    RETURNING ans.business_id, ans.event_type
  )
  SELECT c.business_id, c.user_id, c.event_type, c.action_type
  FROM candidates c
  JOIN marked m ON m.business_id = c.business_id AND m.event_type = c.event_type;
END;
$$;

-- service_role only — explicit revoke, PUBLIC alone is not enough on this
-- stack (see CLAUDE.md's REVOKE EXECUTE note from migration_v137.sql).
REVOKE EXECUTE ON FUNCTION get_and_mark_activation_nudges() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_and_mark_activation_nudges() TO service_role;
