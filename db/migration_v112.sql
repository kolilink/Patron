-- ============================================================
-- Patron — Migration v112
-- Run in Supabase SQL Editor AFTER migration_v111
--
-- Security fix: OTP verification codes had no limit on how many
-- times a code could be GUESSED. The existing rate limits
-- (phone_verification_attempts / email_verification_attempts)
-- only throttle how often a NEW code can be requested (5 per
-- 10 min) — once an attacker holds a verificationId, they could
-- submit unlimited 6-digit guesses until it expired (5–30 min
-- depending on flow), i.e. up to 1,000,000 attempts.
--
-- This adds a per-verification failed-attempt counter. After 5
-- wrong guesses, the row is locked and the caller must request a
-- fresh code (which is already rate-limited). Combined effect:
-- ~25 guesses per 10-minute window instead of effectively unlimited.
-- ============================================================

ALTER TABLE phone_verifications
  ADD COLUMN IF NOT EXISTS failed_attempts int NOT NULL DEFAULT 0;

ALTER TABLE email_verifications
  ADD COLUMN IF NOT EXISTS failed_attempts int NOT NULL DEFAULT 0;
