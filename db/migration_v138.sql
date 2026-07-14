-- v138: Alpha quota-reset push reminder ("Vous pouvez parler à Alpha
-- maintenant" / "...Alpha Pro maintenant") for both free and paid tiers.
--
-- alpha_quota (migration_v133+) tracks a *fixed* window, not a sliding one —
-- window_start/count_in_window only ever advance the next time that user
-- calls send_alpha_message(), so once someone hits their limit the row just
-- sits there "exhausted, window already past 24h" until they either try
-- again (which lazily resets it) or this reminder catches it first. That
-- fixed-window property is what makes a single deterministic "you can send
-- again now" instant possible at all — a true sliding window has no such
-- moment to notify at.
ALTER TABLE alpha_quota ADD COLUMN reset_notified_at timestamptz;

-- Finds every user whose quota window expired while they were still at
-- their limit, and who hasn't been notified about *this particular* reset
-- yet (reset_notified_at is compared against window_start, not just "is
-- null", so the same user can be notified again the next time they exhaust
-- a fresh window). Marks each returned row as notified in the same
-- statement so an overlapping/retried cron run can't double-send.
-- business_id/tier are resolved from the user's most recently active Alpha
-- conversation, since alpha_quota itself isn't scoped to a business.
-- has_ai_access() takes a plain business_id with no auth.uid() dependency,
-- so it's safe to call here for an arbitrary user's business.
CREATE OR REPLACE FUNCTION get_and_mark_alpha_quota_resets()
RETURNS TABLE (user_id uuid, business_id uuid, tier text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT
      q.user_id,
      c.business_id,
      q.count_in_window,
      CASE WHEN has_ai_access(c.business_id) THEN 'paid' ELSE 'free' END AS tier,
      CASE WHEN has_ai_access(c.business_id) THEN 20 ELSE 5 END AS v_limit
    FROM alpha_quota q
    JOIN LATERAL (
      SELECT ac.business_id
      FROM alpha_conversations ac
      WHERE ac.user_id = q.user_id
      ORDER BY ac.last_message_at DESC NULLS LAST
      LIMIT 1
    ) c ON true
    WHERE now() - q.window_start >= interval '24 hours'
      AND (q.reset_notified_at IS NULL OR q.reset_notified_at < q.window_start)
  ),
  exhausted AS (
    SELECT * FROM candidates WHERE count_in_window >= v_limit
  ),
  marked AS (
    UPDATE alpha_quota
    SET reset_notified_at = now()
    WHERE alpha_quota.user_id IN (SELECT exhausted.user_id FROM exhausted)
    RETURNING alpha_quota.user_id
  )
  SELECT exhausted.user_id, exhausted.business_id, exhausted.tier
  FROM exhausted
  JOIN marked ON marked.user_id = exhausted.user_id;
END;
$$;

-- Only the send-alpha-quota-reminders cron job (service role) should ever
-- call this — it silently marks rows as notified, so a regular user calling
-- it directly could make themselves (or anyone else) miss their own
-- reminder, and it returns other users' business_id/tier.
-- REVOKE ... FROM PUBLIC alone is not enough — see migration_v137.sql for
-- why anon/authenticated need an explicit revoke too on this Supabase stack.
REVOKE EXECUTE ON FUNCTION get_and_mark_alpha_quota_resets() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_and_mark_alpha_quota_resets() TO service_role;
