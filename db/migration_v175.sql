-- migration_v175: get_founder_growth_stats() gains total_real_businesses —
-- needed so the client can color-code the North Star card (weekly
-- transacting shops) as a *rate* against the whole real user base, not a
-- raw count against an arbitrary fixed number that goes stale as the
-- platform grows. See src/utils/growthConstraint.ts for how it's used
-- (weekly_transacting_shops / total_real_businesses, benchmarked).
--
-- Return type is changing (one column added), so a plain CREATE OR REPLACE
-- is not enough — Postgres refuses to change an existing function's return
-- type in place. Explicit DROP first, same requirement already documented
-- in CLAUDE.md for migration_v132.sql's send_support_message() case.

DROP FUNCTION IF EXISTS get_founder_growth_stats();

CREATE OR REPLACE FUNCTION get_founder_growth_stats()
RETURNS TABLE (
  activation_rate_pct      numeric,
  week1_retention_pct      numeric,
  week4_retention_pct      numeric,
  weekly_transacting_shops bigint,
  total_real_businesses    bigint
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
         AND sale_date >= now() - interval '7 days'),
    (SELECT count(*) FROM growth_metrics);
END;
$$;

REVOKE EXECUTE ON FUNCTION get_founder_growth_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_founder_growth_stats() TO authenticated;
