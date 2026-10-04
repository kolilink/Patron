-- ============================================================
-- Patron — Migration v226
-- Run in Supabase SQL Editor AFTER migration_v225
--
-- SECURITY FIX: unauthenticated financial reads.
--
-- get_reports_snapshot() and get_period_report() (SECURITY DEFINER) both
-- treat `auth.uid() IS NULL` as the trusted internal/service path and then
-- believe the caller-supplied p_role / p_user_id:
--     IF auth.uid() IS NOT NULL AND NOT is_member(p_business_id) THEN RAISE
--     ...
--     ELSE v_role := p_role; v_user_id := p_user_id;
-- But `anon` (and PUBLIC) hold EXECUTE on both, and an anon-key caller has
-- auth.uid() = NULL. So anyone who knew a business UUID could call
--     get_reports_snapshot(<uuid>, 30, 'administrateur', NULL)
-- and read that business's full financials (revenue, profit, cash, credit,
-- top sellers…) with no account at all.
--
-- Fix is grants only — the function bodies are NOT touched (the service-role
-- path is intentional and keeps working). REVOKE from PUBLIC *and* anon:
-- anon holds its own direct grant (Supabase default privileges), so revoking
-- PUBLIC alone would leave it in place. EXECUTE is then granted explicitly to
-- the two roles that legitimately call these:
--   authenticated — the app (stores/rapports.ts via the user's session;
--                   demo-mode anonymous sign-in users also carry the
--                   `authenticated` role, so they are unaffected)
--   service_role  — internal/reconciliation callers
-- Authenticated callers remain governed by the functions' own is_member()
-- check and server-side role derivation (migration_v121).
-- ============================================================

REVOKE EXECUTE ON FUNCTION public.get_reports_snapshot(uuid, integer, text, uuid, date) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_period_report(uuid, date, date, text, uuid)        FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.get_reports_snapshot(uuid, integer, text, uuid, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_period_report(uuid, date, date, text, uuid)        TO authenticated, service_role;
