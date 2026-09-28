-- ============================================================
-- Patron — Migration v164
-- Run in Supabase SQL Editor AFTER migration_v163
--
-- Schedules send-second-action-reminders hourly via pg_cron — same pattern
-- as migration_v162.sql. Reuses the shared 'patron_cron_secret' Vault
-- entry, not a dedicated secret.
--
-- IMPORTANT — same caveat as every other cron migration in this project:
-- send-second-action-reminders' own CRON_SECRET Edge Function secret must
-- hold the exact same string as 'patron_cron_secret' in Vault, or this
-- schedule fires hourly and 401s silently every time. Verify live before
-- trusting it's running — this exact mismatch has already bitten this
-- codebase twice (see CLAUDE.md's "Alpha WhatsApp reminder" entry).
-- ============================================================

SELECT cron.schedule(
  'patron-second-action-reminders',
  '0 * * * *',  -- every hour, on the hour
  $$
  SELECT net.http_post(
    url     := 'https://jnxpujsyvbenqgjbvifh.supabase.co/functions/v1/send-second-action-reminders',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'patron_cron_secret')
    ),
    body    := '{}'::jsonb
  );
  $$
);
