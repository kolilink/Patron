-- ============================================================
-- Patron — Migration v131
-- Run in Supabase SQL Editor AFTER migration_v130
--
-- Removes the local PIN-lock feature (see migration_v129) — app
-- re-entry is now biometric-only, falling back to a full WhatsApp
-- OTP re-login when biometric is unavailable/fails. No PIN of any
-- kind survives, so the cross-device sync columns it depended on
-- are dead weight.
--
-- memberships.pin_hash (db/schema.sql) is a separate, pre-existing
-- dead column never read/written by any app code — unrelated to
-- this feature, but confirmed unused, so dropped in the same pass.
-- ============================================================

ALTER TABLE profiles
  DROP COLUMN IF EXISTS pin_hash,
  DROP COLUMN IF EXISTS pin_updated_at;

ALTER TABLE memberships
  DROP COLUMN IF EXISTS pin_hash;
