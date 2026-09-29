-- v154: per-device timezone for the quiet-hours check.
--
-- dispatch-notification's quiet-hours gate (migration_v151.sql) was hardcoded
-- to UTC — correct only because Guinea has no DST and is UTC+0, but wrong
-- the moment a vendor is on a device in any other timezone (their real
-- 21:00-07:00 wind-down window would land at the wrong UTC hour). This adds
-- a nullable timezone column, populated by the app at push-token
-- registration; NULL means "unknown, treat as UTC" — the default, so
-- existing tokens (registered before this shipped) behave exactly as
-- before until the app re-registers them with a real IANA zone.

ALTER TABLE device_tokens ADD COLUMN IF NOT EXISTS timezone text;
