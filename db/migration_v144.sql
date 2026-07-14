-- ============================================================
-- Patron — Migration v144
-- Run in Supabase SQL Editor AFTER migration_v143
--
-- Schedules send-alpha-whatsapp-reminder daily via pg_cron — same
-- pattern as migration_v141.sql's djomi-sweep schedule. Reuses the
-- shared 'patron_cron_secret' Vault entry, not a dedicated secret.
--
-- IMPORTANT — same caveat as migration_v141.sql: send-alpha-whatsapp-
-- reminder's own CRON_SECRET Edge Function secret must hold the exact
-- same string as 'patron_cron_secret' in Vault, or this schedule fires
-- daily and 401s silently every time. Also requires
-- META_WHATSAPP_TOKEN and META_WHATSAPP_PHONE_NUMBER_ID to be set as
-- Edge Function secrets before this does anything useful — see
-- CLAUDE.md's "Alpha WhatsApp reminder" entry.
--
-- Runs once daily, early morning (07:00 UTC ≈ early morning in Guinea,
-- GMT year-round, no DST) — no strong reason it needs to run more
-- than once a day, since the underlying signal (3+ capped days in the
-- last week) only meaningfully changes once a day at most.
-- ============================================================

SELECT cron.schedule(
  'patron-alpha-whatsapp-reminder',
  '0 7 * * *',  -- daily, 07:00 UTC
  $$
  SELECT net.http_post(
    url     := 'https://jnxpujsyvbenqgjbvifh.supabase.co/functions/v1/send-alpha-whatsapp-reminder',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'patron_cron_secret')
    ),
    body    := '{}'::jsonb
  );
  $$
);
