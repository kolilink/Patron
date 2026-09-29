-- v153: lower learn_digest_send_hours()'s clamp ceiling from 21 to 20.
--
-- The notification-launch-allowlist deploy (migration_v151.sql) put a hard
-- quiet-hours gate in dispatch-notification: 21:00-07:00 UTC, START
-- INCLUSIVE. v139's clamp on digest_send_hour was LEAST(21, ...) — a
-- business whose learned wind-down hour lands on 21 would have its digest
-- silently dropped by the quiet-hours check every single day, forever,
-- with no error and no retry (drop-not-hold, see migration_v151.sql's
-- CLAUDE.md entry). No business is at hour 20 or 21 today (checked live:
-- 179 @ 17, 1 @ 19), so this hasn't actually fired yet — but it's a
-- structural collision waiting to happen the moment any business's pattern
-- drifts there, not a hypothetical.
--
-- Fix: cap at 20, one hour clear of the quiet-hours boundary, instead of
-- landing exactly on it. This is a plain CREATE OR REPLACE — same
-- signature, same return type, no DROP FUNCTION needed.

CREATE OR REPLACE FUNCTION learn_digest_send_hours()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  WITH daily_last_sale AS (
    SELECT
      business_id,
      sale_date,
      MAX(EXTRACT(HOUR FROM created_at)) AS last_hour
    FROM sale_orders
    WHERE sale_date >= current_date - 14
      AND status IN ('paye', 'credit')
    GROUP BY business_id, sale_date
  ),
  business_typical_hour AS (
    SELECT
      business_id,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY last_hour) AS median_last_hour,
      COUNT(*) AS days_with_sales
    FROM daily_last_sale
    GROUP BY business_id
  )
  UPDATE businesses b
  SET digest_send_hour = CASE
    WHEN t.days_with_sales >= 5 THEN LEAST(20, GREATEST(16, ROUND(t.median_last_hour + 1)::int))
    ELSE 17
  END
  FROM business_typical_hour t
  WHERE b.id = t.business_id;

  UPDATE businesses SET digest_send_hour = 17 WHERE digest_send_hour IS NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION learn_digest_send_hours() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION learn_digest_send_hours() TO service_role;

-- One-time correction so any business already stamped 21 (none exist today,
-- checked live, but this makes the migration correct regardless of when it
-- runs) doesn't have to wait for tomorrow's 05:00 UTC recompute.
UPDATE businesses SET digest_send_hour = 20 WHERE digest_send_hour = 21;
