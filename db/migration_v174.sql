-- migration_v174: Founder growth metrics v2 — activation / retention /
-- North Star framework, replacing the ad hoc D7-retention / daily-active /
-- TTFR / avg-tx-per-user panel from migration_v156.sql/v167.sql (that RPC,
-- get_founder_activity_raw(), is left deployed and untouched — still a
-- valid, working function — it's just no longer called by the app; see
-- CLAUDE.md's "Founder Dashboard" section).
--
-- growth_metrics is a business-level cohort view, one row per real
-- (non-demo) business:
--   business_id, signup_at, activated_72h, week1_retained, week4_retained
--
-- ── Why business-level, not user-level ──────────────────────────────────
-- The previous framework's cohort was individual users; this one is
-- businesses (shops) — matches how the founder actually thinks about
-- growth here ("how many shops are alive"), and matches the North Star
-- query (distinct business_id transacting per week) directly.
--
-- ── Excluding demo/anonymous businesses ─────────────────────────────────
-- seed-demo-business (supabase/functions/seed-demo-business) seeds a fake
-- "Boutique Démo" business with ~12 fake sale_orders at convenient fixed
-- date offsets (3 dated "today", one at exactly "7 days ago") for every
-- anonymous "Essayer" tap — this is the *exact* contamination that made
-- get_founder_activity_raw() read garbage numbers before migration_v167.sql
-- filtered it out. Every demo business (and every business created by an
-- abandoned anonymous phone-auth attempt, however unlikely) has
-- businesses.created_by pointing at a profile with phone IS NULL — the same
-- "real user" filter already established in v143/v145/v149/v167 — so this
-- view joins to profiles and filters on that instead of matching the
-- literal, renamable "Boutique Démo" name.
--
-- ── Three-state flags, not two ──────────────────────────────────────────
-- Each flag is TRUE the moment the qualifying action is observed within its
-- window, FALSE once the window has fully elapsed with no such action, and
-- NULL while the window is still open (not yet resolved either way). This
-- avoids the exact bug class migration_v156.sql's old calculateD7Retention
-- already hit once: prematurely reading "not retained" for a cohort member
-- who simply hasn't had their full window yet. A plain boolean (defaulting
-- false) would silently understate every rate for the platform's most
-- recent signups.
--
-- ── activated_72h ────────────────────────────────────────────────────────
-- Mirrors this app's own established activation definition (the
-- ActivationForkOverlay / get_and_mark_activation_reminders() two-signal
-- check: product OR non-cancelled sale — a credit sale is already a
-- sale_orders row, not a separate signal) rather than inventing a new one,
-- evaluated within 72h of business creation instead of the fork's 24h
-- reminder window.
--
-- ── week1_retained / week4_retained ──────────────────────────────────────
-- "Did this business record a real (paye/credit) sale during the 7-day
-- window starting exactly 1 (or 4) week(s) after signup" — a week-wide
-- window, not a single calendar day, for the same reason migration_v156.sql
-- had to widen D7 retention's cohort matching: at this app's real signup
-- volume, a single-day check is very often empty. Uses sale_date (the
-- day-granular field already used for revenue/activity bucketing
-- everywhere else in this codebase — reports, daily digest) rather than
-- created_at, for consistency with the North Star query below, which is
-- itself given verbatim, unchanged, by product direction.
--
-- get_founder_growth_stats() computes the 4 numbers the founder asked for,
-- directly, in the same shape:
--   1. Activation rate — of businesses that signed up in the last 30 days.
--   2. Week 1 retention — of activated businesses only.
--   3. Week 4 retention — of activated businesses only.
--   4. Weekly transacting shops (North Star) — distinct businesses with a
--      real sale in the last 7 days, not scoped to growth_metrics at all
--      (a shop transacting this week doesn't need to be a "recent signup"
--      to count for this one).
--
-- No new RLS policy needed anywhere — growth_metrics has SELECT revoked
-- from every client-facing role, reachable only from inside this
-- SECURITY DEFINER function (same posture as djomi_pending_payments /
-- support_ai_drafts: a real object with no client-facing policy at all).

CREATE OR REPLACE VIEW growth_metrics AS
WITH biz AS (
  SELECT b.id AS business_id, b.created_at AS signup_at
  FROM businesses b
  JOIN profiles p ON p.id = b.created_by
  WHERE p.phone IS NOT NULL AND p.phone <> ''
)
SELECT
  biz.business_id,
  biz.signup_at,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM products pr
      WHERE pr.business_id = biz.business_id
        AND pr.created_at <= biz.signup_at + interval '72 hours'
    ) OR EXISTS (
      SELECT 1 FROM sale_orders so
      WHERE so.business_id = biz.business_id
        AND so.status != 'annule'
        AND so.created_at <= biz.signup_at + interval '72 hours'
    ) THEN true
    WHEN now() >= biz.signup_at + interval '72 hours' THEN false
    ELSE NULL
  END AS activated_72h,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM sale_orders so
      WHERE so.business_id = biz.business_id
        AND so.status IN ('paye', 'credit')
        AND so.sale_date >= (biz.signup_at::date + 7)
        AND so.sale_date <  (biz.signup_at::date + 14)
    ) THEN true
    WHEN now() >= biz.signup_at + interval '14 days' THEN false
    ELSE NULL
  END AS week1_retained,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM sale_orders so
      WHERE so.business_id = biz.business_id
        AND so.status IN ('paye', 'credit')
        AND so.sale_date >= (biz.signup_at::date + 28)
        AND so.sale_date <  (biz.signup_at::date + 35)
    ) THEN true
    WHEN now() >= biz.signup_at + interval '35 days' THEN false
    ELSE NULL
  END AS week4_retained
FROM biz;

REVOKE ALL ON growth_metrics FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION get_founder_growth_stats()
RETURNS TABLE (
  activation_rate_pct     numeric,
  week1_retention_pct     numeric,
  week4_retention_pct     numeric,
  weekly_transacting_shops bigint
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
    (SELECT count(*) FILTER (WHERE activated_72h) * 100.0 / NULLIF(count(*), 0)
       FROM growth_metrics
       WHERE signup_at >= now() - interval '30 days'),
    (SELECT count(*) FILTER (WHERE week1_retained) * 100.0 / NULLIF(count(*) FILTER (WHERE activated_72h), 0)
       FROM growth_metrics
       WHERE activated_72h),
    (SELECT count(*) FILTER (WHERE week4_retained) * 100.0 / NULLIF(count(*) FILTER (WHERE activated_72h), 0)
       FROM growth_metrics
       WHERE activated_72h),
    (SELECT count(DISTINCT business_id) FROM sale_orders
       WHERE status IN ('paye', 'credit')
         AND sale_date >= now() - interval '7 days');
END;
$$;

REVOKE EXECUTE ON FUNCTION get_founder_growth_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_founder_growth_stats() TO authenticated;
