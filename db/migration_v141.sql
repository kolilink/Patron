-- ============================================================
-- Patron — Migration v141
-- Run in Supabase SQL Editor AFTER migration_v140
--
-- Schedules djomi-sweep hourly via pg_cron — the safety net that
-- re-checks any Djomi payment still unresolved after djomi-checkout's
-- own ~2-minute poll window gives up (a merchant who paid via Orange
-- Money but never returned to the tab: closed the browser, switched
-- apps, connection dropped, phone died). Without this, that payment
-- would never be re-checked and the merchant's subscription would
-- never activate despite having paid. See CLAUDE.md's "Djomi
-- out-of-app subscription" entry and supabase/functions/djomi-sweep.
--
-- Reuses the same shared Vault secret ('patron_cron_secret') every
-- other cron-triggered function in this project already authenticates
-- with (send-report-email, send-alpha-quota-reminders, etc.) — not a
-- djomi-specific secret, so no new Vault entry is created here.
--
-- IMPORTANT — two separate secret stores have to agree: djomi-sweep's
-- own CRON_SECRET Edge Function secret (set via
-- `supabase secrets set CRON_SECRET=...` when djomi-sweep was
-- deployed) must hold the EXACT SAME string as the 'patron_cron_secret'
-- Vault entry referenced below, or every invocation from this schedule
-- will get a 401 from djomi-sweep's own auth check and silently do
-- nothing every hour. If djomi-sweep's CRON_SECRET was set to a
-- different value earlier, re-run
-- `supabase secrets set CRON_SECRET=<the same value as patron_cron_secret>`
-- before trusting this schedule is actually working.
-- ============================================================

SELECT cron.schedule(
  'patron-djomi-sweep',
  '0 * * * *',  -- every hour, on the hour
  $$
  SELECT net.http_post(
    url     := 'https://jnxpujsyvbenqgjbvifh.supabase.co/functions/v1/djomi-sweep',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'patron_cron_secret')
    ),
    body    := '{}'::jsonb
  );
  $$
);
