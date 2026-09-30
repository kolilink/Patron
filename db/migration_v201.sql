-- ============================================================
-- Patron — Migration v201
-- Run in Supabase SQL Editor AFTER migration_v200
--
-- Schedules send-debt-reminders hourly via pg_cron — same shared
-- 'patron_cron_secret' Vault entry every other cron-triggered function in
-- this project already authenticates with (see migration_v141.sql for the
-- full explanation of that shared-secret pattern and the two-store-agree
-- pitfall to check if this ever silently stops firing).
-- ============================================================

SELECT cron.schedule(
  'patron-debt-reminders',
  '0 * * * *',  -- every hour, on the hour
  $$
  SELECT net.http_post(
    url     := 'https://jnxpujsyvbenqgjbvifh.supabase.co/functions/v1/send-debt-reminders',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'patron_cron_secret')
    ),
    body    := '{}'::jsonb
  );
  $$
);
