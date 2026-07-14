-- v139: habit-forming afternoon "how did the shop do" digest push.
--
-- Two design decisions baked into this schema:
--
-- 1. Timing is per-business and learned, not a flat clock time for every
--    business. learn_digest_send_hours() looks at each business's last 14
--    days of sales, finds the hour their *last* sale of the day usually
--    lands at, and sets digest_send_hour to 1 hour after that (their
--    natural wind-down point) — clamped to 16:00-21:00 (Guinea is GMT
--    year-round, no DST, so this UTC window is also the local 4pm-9pm
--    window). Businesses with fewer than 5 sale-days in the trailing window
--    (brand new, or genuinely dormant) get a flat 17:00 default instead —
--    not enough signal yet to trust a learned pattern.
-- 2. Every business gets a push every day it's due, regardless of whether
--    anything happened — a habit-forming trigger has to be reliable, or it
--    stops meaning anything (see CLAUDE.md's "Alpha" section for the same
--    reasoning applied to the quota-reset reminder). The message itself
--    branches on whether there was revenue today ("bonne") or not ("calme")
--    — see dispatch-notification's daily_digest case for the actual copy.

ALTER TABLE businesses ADD COLUMN digest_send_hour SMALLINT;
ALTER TABLE businesses ADD COLUMN digest_last_sent_date DATE;

-- Run once daily (early morning, before shops open) by the
-- learn-digest-send-hours cron. Recomputing every day lets the send hour
-- drift with a business's actual hours instead of freezing at whatever it
-- was on day 1.
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
    WHEN t.days_with_sales >= 5 THEN LEAST(21, GREATEST(16, ROUND(t.median_last_hour + 1)::int))
    ELSE 17
  END
  FROM business_typical_hour t
  WHERE b.id = t.business_id;

  -- Businesses with zero sales at all in the trailing window never appear
  -- in business_typical_hour above — give them the same flat default so
  -- every business always ends up with a value.
  UPDATE businesses SET digest_send_hour = 17 WHERE digest_send_hour IS NULL;
END;
$$;

-- REVOKE ... FROM PUBLIC alone is not enough — see migration_v137.sql for
-- why anon/authenticated need an explicit revoke too on this Supabase stack.
REVOKE EXECUTE ON FUNCTION learn_digest_send_hours() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION learn_digest_send_hours() TO service_role;

-- Run hourly by the send-daily-digest cron. Finds every business whose
-- learned send hour is the current hour and hasn't been sent to yet today,
-- computes today's revenue (same formula as get_reports_snapshot: paye +
-- credit orders, total_amount minus discount), and marks them sent in the
-- same statement so an overlapping cron run can't double-send.
CREATE OR REPLACE FUNCTION get_and_mark_daily_digest_businesses()
RETURNS TABLE (business_id uuid, tier text, revenue_cents bigint, currency text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hour  int  := EXTRACT(HOUR FROM now())::int;
  v_today date := current_date;
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT
      b.id,
      b.currency,
      COALESCE((
        SELECT SUM(so.total_amount - COALESCE(so.discount_amount, 0))
        FROM sale_orders so
        WHERE so.business_id = b.id
          AND so.status IN ('paye', 'credit')
          AND so.sale_date = v_today
      ), 0)::bigint AS revenue_cents
    FROM businesses b
    WHERE b.digest_send_hour = v_hour
      AND (b.digest_last_sent_date IS NULL OR b.digest_last_sent_date < v_today)
  ),
  marked AS (
    UPDATE businesses
    SET digest_last_sent_date = v_today
    WHERE businesses.id IN (SELECT due.id FROM due)
    RETURNING businesses.id
  )
  SELECT due.id, CASE WHEN due.revenue_cents > 0 THEN 'bonne' ELSE 'calme' END, due.revenue_cents, due.currency
  FROM due
  JOIN marked ON marked.id = due.id;
END;
$$;

-- REVOKE ... FROM PUBLIC alone is not enough — see migration_v137.sql for
-- why anon/authenticated need an explicit revoke too on this Supabase stack.
REVOKE EXECUTE ON FUNCTION get_and_mark_daily_digest_businesses() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_and_mark_daily_digest_businesses() TO service_role;
