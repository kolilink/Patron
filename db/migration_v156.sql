-- migration_v156: Founder Dashboard — raw per-user activity feed.
--
-- Backs src/components/FounderDashboard.tsx's 4 First Principles growth KPIs
-- (D7 retention, daily active transacting rate, TTFR, avg transactions per
-- active user — see src/utils/founderMetrics.ts for the calculation logic
-- itself). Founder-only (is_founder() — the same global profiles.phone
-- match migration_v126.sql already uses for the support inbox, independent
-- of any business role).
--
-- Returns one row per user: their signup timestamp and the full array of
-- their own (non-cancelled) sale timestamps — a plain, source-agnostic shape
-- the client maps 1:1 onto UserActivityRecord[]. Deliberately NOT windowed
-- to "recent" users/sales: several of the KPIs (D7 retention's cohort match,
-- "total users" as the daily-active-rate denominator) need the true full
-- population, and at this platform's current scale a full profiles+sale_orders
-- scan is cheap. Revisit with a window/pagination if that stops being true.
--
-- SECURITY DEFINER is required because a plain founder session has no RLS
-- grant to read every user's profile or every business's sale_orders —
-- is_member(business_id) would block all of it. The function re-checks
-- is_founder() before returning anything, so the privilege escalation never
-- reaches a non-founder caller.

CREATE OR REPLACE FUNCTION get_founder_activity_raw()
RETURNS TABLE (
  user_id        uuid,
  signup_at      timestamptz,
  transaction_at timestamptz[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
BEGIN
  IF NOT is_founder() THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  SELECT
    p.id,
    p.created_at,
    -- seller_id, not created_by — this is "who logged the transaction" for
    -- KPI purposes (submit_sale enforces seller_id = auth.uid()), matching
    -- how TTFR/daily-active are meant to read: a personal activity signal,
    -- not whoever's session happened to submit it.
    COALESCE(
      array_agg(so.created_at ORDER BY so.created_at) FILTER (WHERE so.created_at IS NOT NULL),
      ARRAY[]::timestamptz[]
    )
  FROM profiles p
  LEFT JOIN sale_orders so
    ON so.seller_id = p.id AND so.status != 'annule'
  GROUP BY p.id, p.created_at;
END;
$$;

REVOKE EXECUTE ON FUNCTION get_founder_activity_raw() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_founder_activity_raw() TO authenticated;
