-- ============================================================
-- Patron — Migration v166
-- Run in Supabase SQL Editor AFTER migration_v165
--
-- Schedules send-revenue-milestone-reminders hourly via pg_cron — same
-- pattern as every other cron migration in this project. Reuses the shared
-- 'patron_cron_secret' Vault entry, not a dedicated secret.
--
-- IMPORTANT — same caveat as every prior cron migration: send-revenue-
-- milestone-reminders' own CRON_SECRET Edge Function secret must hold the
-- exact same string as 'patron_cron_secret' in Vault, or this schedule
-- fires hourly and 401s silently every time. Verify live before trusting
-- it's running (see migration_v163.sql's own real instance of this exact
-- gap going unnoticed until checked directly against the linked database).
-- ============================================================

SELECT cron.schedule(
  'patron-revenue-milestones',
  '0 * * * *',  -- every hour, on the hour
  $$
  SELECT net.http_post(
    url     := 'https://jnxpujsyvbenqgjbvifh.supabase.co/functions/v1/send-revenue-milestone-reminders',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'patron_cron_secret')
    ),
    body    := '{}'::jsonb
  );
  $$
);
