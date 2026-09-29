-- ============================================================
-- Patron — Migration v156
-- Run in Supabase SQL Editor AFTER migration_v155
--
-- Schedules send-activation-nudges hourly via pg_cron — same
-- 'patron_cron_secret' Vault pattern as migration_v141.sql/v144.sql.
-- Hourly (not daily) because activation_nudge_1's window is only 2h
-- wide (T+4h to T+6h) — a daily tick would miss most businesses'
-- window entirely.
--
-- IMPORTANT — same caveat as every other cron-triggered function here:
-- send-activation-nudges' own CRON_SECRET Edge Function secret must
-- hold the exact same string as 'patron_cron_secret' in Vault, or this
-- 401s silently on every run (see migration_v149.sql's postmortem for
-- how long that class of bug can go unnoticed).
-- ============================================================

SELECT cron.schedule(
  'patron-activation-nudges',
  '0 * * * *',  -- hourly
  $$
  SELECT net.http_post(
    url     := 'https://jnxpujsyvbenqgjbvifh.supabase.co/functions/v1/send-activation-nudges',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'patron_cron_secret')
    ),
    body    := '{}'::jsonb
  );
  $$
);
