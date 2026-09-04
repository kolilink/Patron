-- ============================================================
-- Patron — Migration v171
-- Run in Supabase SQL Editor AFTER migration_v170
--
-- Schedules process-scheduled-account-deletions daily via pg_cron — same
-- 'patron_cron_secret' Vault pattern as migration_v141/v144/v162/v164/v166.
-- Daily (not hourly) is deliberate: a 30-day deadline has no need for
-- hour-level precision, unlike the reminder pushes those other jobs send.
--
-- IMPORTANT — same caveat as every prior cron migration in this file:
-- process-scheduled-account-deletions' own CRON_SECRET Edge Function secret
-- must hold the exact same string as 'patron_cron_secret' in Vault, and the
-- function must be deployed with --no-verify-jwt (it authenticates via
-- x-cron-secret, not a Supabase JWT — see CLAUDE.md's "A missing
-- --no-verify-jwt deploy flag silently killed every cron-triggered push for
-- 3 weeks" entry). Smoke-test with a real net.http_post call and inspect
-- net._http_response before trusting this is actually running — a clean
-- deploy and an active cron.job row both look identical whether or not the
-- function is actually reachable.
-- ============================================================

SELECT cron.schedule(
  'patron-process-scheduled-account-deletions',
  '0 4 * * *',  -- once daily, 4am UTC
  $$
  SELECT net.http_post(
    url     := 'https://jnxpujsyvbenqgjbvifh.supabase.co/functions/v1/process-scheduled-account-deletions',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'patron_cron_secret')
    ),
    body    := '{}'::jsonb
  );
  $$
);
