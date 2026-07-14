-- ============================================================
-- Patron — Migration v143
-- Run in Supabase SQL Editor AFTER migration_v142
--
-- The targeting logic for the Alpha WhatsApp re-engagement reminder —
-- see CLAUDE.md's "Alpha WhatsApp reminder" entry and
-- supabase/functions/send-alpha-whatsapp-reminder.
--
-- Deliberately NOT triggered on every free-tier block (that's already
-- free and instant via the in-app upgrade popup, which fires on every
-- blocked send attempt). This is the escalation for people the popup
-- alone hasn't converted: a business whose administrateur has hit the
-- free daily cap on at least 3 separate days in the last 7, and still
-- has no paid/trial/bonus access. Real repeated behavior, not a guess
-- about who they are or what phone carrier they use (see prior
-- conversation reasoning — carrier-prefix targeting was considered
-- and rejected as unreliable and beside the point, since payment can
-- come from any Orange number, not necessarily the recipient's own).
--
-- Scoped to the ADMINISTRATEUR's own usage specifically, not aggregated
-- across every member of the business — a deliberate simplification.
-- The administrateur is both the person who can act on the reminder
-- (only administrateurs can activate a subscription — see
-- resolve_business_for_djomi_checkout, migration_v140.sql) and,
-- typically, a real Alpha user themselves. A vendeur hammering the
-- free tier while the administrateur never personally touches Alpha
-- would be missed by this design — a known, accepted limitation, not
-- an oversight.
--
-- Sent at most ONCE EVER per business (alpha_whatsapp_reminders_sent),
-- not on a cooldown — "one nudge, not a campaign." A business that
-- later resubscribes and lapses again would need a product decision
-- (and likely a migration) to re-enable reminding them.
-- ============================================================

CREATE TABLE IF NOT EXISTS alpha_whatsapp_reminders_sent (
  business_id uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  sent_at     timestamptz NOT NULL DEFAULT now()
);

-- service_role only, same posture as djomi_pending_payments — no client
-- (anon/authenticated) has any business reading or writing this
-- directly; RLS enabled with zero policies denies both by default.
ALTER TABLE alpha_whatsapp_reminders_sent ENABLE ROW LEVEL SECURITY;

-- get_and_mark_alpha_whatsapp_candidates: atomically finds qualifying
-- businesses AND marks them sent in the same call, so two overlapping
-- cron runs can never both pick up the same business — same shape as
-- get_and_mark_daily_digest_businesses (migration_v139.sql) and
-- get_and_mark_alpha_quota_resets (migration_v138.sql). Marks BEFORE
-- the edge function actually calls Meta's API, not after: if the send
-- itself fails, that business is silently skipped rather than risking
-- a duplicate/spammy resend on the next run. A silent miss is an
-- acceptable cost here (they still see the in-app popup regardless);
-- a duplicate send is not, for a "one nudge, not a campaign" message.
CREATE OR REPLACE FUNCTION get_and_mark_alpha_whatsapp_candidates()
RETURNS TABLE(business_id uuid, admin_phone text, checkout_token text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH admins AS (
    SELECT m.business_id, m.user_id, p.phone
    FROM memberships m
    JOIN profiles p ON p.id = m.user_id
    WHERE m.role = 'administrateur' AND p.phone IS NOT NULL
  ),
  capped_days AS (
    -- Every distinct day (UTC — Guinea has no DST, same shortcut used
    -- elsewhere in this codebase) in the last 7 where this admin sent
    -- at least the free-tier cap's worth of messages. 5 is
    -- send_alpha_message's current free v_limit (migration_v136.sql)
    -- — hardcoded here since there's no shared constant to reference
    -- from SQL; keep this in sync if that limit ever changes again.
    SELECT ac.business_id, ac.user_id,
           (am.created_at AT TIME ZONE 'UTC')::date AS day
    FROM alpha_messages am
    JOIN alpha_conversations ac ON ac.id = am.conversation_id
    WHERE am.role = 'user'
      AND am.created_at >= now() - interval '7 days'
    GROUP BY ac.business_id, ac.user_id, (am.created_at AT TIME ZONE 'UTC')::date
    HAVING count(*) >= 5
  ),
  qualifying AS (
    SELECT a.business_id, a.phone
    FROM admins a
    JOIN capped_days cd ON cd.business_id = a.business_id AND cd.user_id = a.user_id
    WHERE NOT has_ai_access(a.business_id)
      AND NOT EXISTS (SELECT 1 FROM alpha_whatsapp_reminders_sent r WHERE r.business_id = a.business_id)
    GROUP BY a.business_id, a.phone
    HAVING count(*) >= 3
  ),
  marked AS (
    INSERT INTO alpha_whatsapp_reminders_sent (business_id)
    SELECT q.business_id FROM qualifying q
    RETURNING business_id
  )
  SELECT m.business_id, q.phone, b.djomi_checkout_token
  FROM marked m
  JOIN qualifying q ON q.business_id = m.business_id
  JOIN businesses b ON b.id = m.business_id;
END;
$$;

-- service_role only — explicit revoke, not just relying on omission
-- (see CLAUDE.md's REVOKE EXECUTE note from migration_v137-v139: this
-- stack grants EXECUTE on new functions directly to anon/authenticated
-- by default, PUBLIC alone isn't enough).
REVOKE EXECUTE ON FUNCTION get_and_mark_alpha_whatsapp_candidates() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_and_mark_alpha_whatsapp_candidates() TO service_role;
