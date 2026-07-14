-- ============================================================
-- Patron — Migration v129
-- Run in Supabase SQL Editor AFTER migration_v128
--
-- Cross-device PIN sync. The local PIN lock (lib/pin.ts) is scoped per
-- device, not per account: the salted hash lives only in that device's
-- Keychain/Keystore and never leaves it. That's correct for *verification*
-- (must work fully offline, no network round trip at unlock time) but wrong
-- for *distribution* — a user who set a PIN on device A had no way for
-- device B to ever learn about it, so device B kept demanding a brand new
-- PIN be created even though the account already had one.
--
-- Fix: profiles gains pin_hash/pin_updated_at so the salted hash (never the
-- raw PIN) can be opportunistically pushed up when a device is online, and
-- pulled down by any other device the next time IT is online — after that
-- pull, verification on that device stays exactly as offline-capable as
-- before, since it's just comparing against the now-locally-cached hash.
-- No new RLS policy needed: "Modifier son profil" (schema.sql, auth.uid() =
-- id) already covers self-service updates to any profiles column, same as
-- recovery_email (migration_v76).
--
-- Tradeoff accepted deliberately: a 4-digit PIN is only 10,000 combinations.
-- While the hash stayed device-only, an attacker needed physical device
-- access to even attempt it. Now that the hash also lives in `profiles`,
-- anyone who could read that row (blocked for other users by RLS; only a
-- service-role key leak bypasses it) could brute-force all 10,000 SHA-256
-- hashes offline in well under a second, with no lockout. Same posture as
-- recovery_email: RLS-protected, not a reason to avoid the feature.
-- ============================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS pin_hash text,
  ADD COLUMN IF NOT EXISTS pin_updated_at timestamptz;
