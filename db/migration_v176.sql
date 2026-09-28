-- ============================================================
-- Patron — Migration v176
-- Run in Supabase SQL Editor AFTER migration_v175
--
-- Adds profiles.notify_on_every_sale — a personal, per-user preference
-- (not per-business) letting an admin/manager turn off the "one push per
-- sale" notification (sale_completed, fired for every sale by any team
-- member on a shop's memberships) without touching any other notification
-- type. Default TRUE so nobody's existing behavior changes — this is an
-- opt-out lever, not an opt-in one.
--
-- Added specifically because this app has no per-category notification
-- control anywhere (confirmed: no in-app preference screen, and only two
-- Android channels total — patron_default/patron_urgent, not one per event
-- type). Research on notification fatigue is consistent that frequency
-- alone drives opt-out (even ~1/week measurably raises the rate), but that
-- the real fix isn't fewer notifications — it's giving people control over
-- which categories they get, since a binary all-or-nothing OS permission
-- pushes people toward disabling everything rather than curating. A busy,
-- successful shop is exactly the profile most likely to hit real volume
-- here (one push per sale, already true before the daily-digest cron in
-- migration_v177.sql is even turned on) — this is the one lever that lets
-- that admin dial down volume without muting sale-completed AND low-stock
-- AND the daily digest AND everything else at the OS level.
-- ============================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS notify_on_every_sale boolean NOT NULL DEFAULT true;
