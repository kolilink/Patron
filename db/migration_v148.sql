-- ============================================================
-- Patron — Migration v148
-- Run in Supabase SQL Editor AFTER migration_v147
--
-- record_alpha_whatsapp_consent now triggers an immediate send attempt
-- on acceptance, instead of only waiting for the next daily cron tick
-- (migration_v144.sql, 07:00 UTC). Explicit product direction: "the
-- moment they're intended to" — someone who just proved intent by
-- hitting the free cap 3 times, then tapped "yes" on the consent
-- prompt, should get the message right then, not up to 24 hours
-- later once the intent has faded. Same reasoning already used to
-- justify the message copy itself (the Zeigarnik/open-loop framing
-- only works if the loop actually closes promptly).
--
-- Implementation: PERFORM net.http_post(...) calling the existing
-- send-alpha-whatsapp-reminder Edge Function directly from inside this
-- RPC — the exact same mechanism migration_v141.sql/migration_v144.sql
-- already use to call an Edge Function from a pg_cron job body, just
-- triggered by a consent event instead of a schedule. net.http_post is
-- asynchronous (queued via pg_net, not awaited), so this doesn't slow
-- down the RPC call itself or block the UI.
--
-- No new code needed in send-alpha-whatsapp-reminder or its targeting
-- RPC — get_and_mark_alpha_whatsapp_candidates() already naturally
-- picks up the just-consented business (it now passes every WHERE
-- condition) whenever it's invoked, whether that's this immediate
-- trigger or the daily cron. Calling it twice in quick succession is
-- safe: already-sent businesses are excluded via the NOT EXISTS check
-- against alpha_whatsapp_reminders_sent, so there's no double-send
-- risk from both paths existing at once.
--
-- The daily cron (migration_v144.sql) is deliberately left scheduled,
-- not removed — a backstop for the case where this immediate
-- net.http_post call fails silently (a pg_net hiccup, a transient
-- network error), same "belt and suspenders" posture as djomi-sweep
-- backstopping djomi-checkout's poll.
-- ============================================================

CREATE OR REPLACE FUNCTION record_alpha_whatsapp_consent(p_business_id uuid, p_accepted boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM memberships
    WHERE business_id = p_business_id AND user_id = auth.uid() AND role = 'administrateur'
  ) THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  UPDATE profiles
  SET alpha_whatsapp_consent = CASE WHEN p_accepted THEN 'accepted' ELSE 'declined' END
  WHERE id = auth.uid();

  IF p_accepted THEN
    PERFORM net.http_post(
      url     := 'https://jnxpujsyvbenqgjbvifh.supabase.co/functions/v1/send-alpha-whatsapp-reminder',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'patron_cron_secret')
      ),
      body    := '{}'::jsonb
    );
  END IF;
END;
$$;
