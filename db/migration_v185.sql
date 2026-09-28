-- ============================================================
-- Patron — Migration v185
-- Run in Supabase SQL Editor AFTER migration_v184
--
-- Schedules the daily-digest habit-loop jobs via pg_cron — same pattern as
-- migration_v141.sql/v144.sql/v162.sql/v164.sql/v166.sql/v171.sql. Both
-- edge functions (send-daily-digest, learn-digest-send-hours) and their
-- backing RPCs (get_and_mark_daily_digest_businesses, migration_v139.sql;
-- learn_digest_send_hours, same file) have existed, fully built and
-- documented, since migration_v139.sql — this is the migration that was
-- apparently never written, so nothing has ever actually fired for a real
-- user despite the feature being "done" for a long time.
--
-- Deliberately NOT scheduling send-alpha-quota-reminders in this same pass
-- (also dormant, also fully built) — see the notification-fatigue research
-- this was weighed against: turning on every dormant push at once risks
-- stacking too much new volume on top of the existing per-sale pings a
-- busy shop already gets, which is exactly the profile most likely to
-- react by disabling notifications entirely. Ship the single calmest,
-- most valuable, exactly-once-a-day message first, watch real engagement/
-- opt-out signal, then reassess the others.
--
-- IMPORTANT — same caveat as every prior cron migration in this file: both
-- edge functions must be deployed with --no-verify-jwt (they authenticate
-- via x-cron-secret, not a Supabase JWT) or every call 401s silently while
-- pg_cron still reports success. This exact failure mode has already
-- bitten three prior cron jobs in this codebase (see CLAUDE.md's "missing
-- --no-verify-jwt" entry) and was only caught by a live end-to-end test,
-- not code review — verify this one the same way (a real net.http_post
-- call + inspecting net._http_response, or supabase functions logs) before
-- trusting it's actually running.
-- ============================================================

-- Hourly — checks which businesses are due *this* hour per their own
-- learned (or default 17:00) send time, per migration_v139.sql's design.
SELECT cron.schedule(
  'patron-send-daily-digest',
  '0 * * * *',
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

-- Once daily, early morning — recomputes each business's learned send hour
-- from its trailing 14-day sales pattern. Kept separate from the hourly
-- job above so the per-business hour isn't relearned on every tick.
SELECT cron.schedule(
  'patron-learn-digest-send-hours',
  '0 5 * * *',
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
