-- ============================================================
-- Patron — Migration v152
-- Run in Supabase SQL Editor AFTER migration_v151
--
-- Schedules send-daily-digest (hourly) and learn-digest-send-hours (once
-- daily, early morning) via pg_cron — the aggregation RPCs and edge
-- functions already existed (migration_v139.sql) but were never actually
-- wired to a schedule. Part of the notification launch allowlist pass —
-- see CLAUDE.md's "Notification launch allowlist" entry.
--
-- Reuses the shared 'patron_cron_secret' Vault entry every other
-- cron-triggered function already authenticates with — not a
-- digest-specific secret.
--
-- IMPORTANT — deploy step this migration does not perform: both
-- send-daily-digest and learn-digest-send-hours must be deployed with
-- `supabase functions deploy <name> --no-verify-jwt` and smoke-tested
-- with a real curl/net.http_post call (confirming a JSON body comes back,
-- not the platform's UNAUTHORIZED_NO_AUTH_HEADER) before this schedule
-- can be trusted to actually deliver anything — see CLAUDE.md's OTA/cron
-- deploy gate for why a "successfully scheduled" cron job can still be
-- silently unreachable.
-- ============================================================

SELECT cron.schedule(
  'patron-send-daily-digest',
  '0 * * * *',  -- every hour, on the hour — the function itself decides who's actually due this hour
  $$
  SELECT net.http_post(
    url     := 'https://jnxpujsyvbenqgjbvifh.supabase.co/functions/v1/send-daily-digest',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'patron_cron_secret')
    ),
    body    := '{}'::jsonb
  );
  $$
);

SELECT cron.schedule(
  'patron-learn-digest-send-hours',
  '0 3 * * *',  -- once daily, 03:00 UTC — well before any business's learned send hour (clamped 16:00-21:00 UTC)
  $$
  SELECT net.http_post(
    url     := 'https://jnxpujsyvbenqgjbvifh.supabase.co/functions/v1/learn-digest-send-hours',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'patron_cron_secret')
    ),
    body    := '{}'::jsonb
  );
  $$
);
