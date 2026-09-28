-- ============================================================
-- Patron — Migration v162
-- Run in Supabase SQL Editor AFTER migration_v161
--
-- Schedules send-activation-reminders hourly via pg_cron — same pattern as
-- migration_v141.sql (djomi-sweep) and migration_v144.sql (Alpha WhatsApp
-- reminder). Reuses the shared 'patron_cron_secret' Vault entry, not a
-- dedicated secret.
--
-- IMPORTANT — same caveat as those two migrations: send-activation-
-- reminders' own CRON_SECRET Edge Function secret must hold the exact same
-- string as 'patron_cron_secret' in Vault, or this schedule fires hourly
-- and 401s silently every time. This exact failure mode has already bitten
-- two prior cron jobs in this codebase (see CLAUDE.md's "Alpha WhatsApp
-- reminder" entry) and was only caught by a live end-to-end test, not code
-- review — verify this one the same way before trusting it's running.
-- ============================================================

SELECT cron.schedule(
  'patron-activation-reminders',
  '0 * * * *',  -- every hour, on the hour
  $$
  SELECT net.http_post(
    url     := 'https://jnxpujsyvbenqgjbvifh.supabase.co/functions/v1/send-activation-reminders',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'patron_cron_secret')
    ),
    body    := '{}'::jsonb
  );
  $$
);
