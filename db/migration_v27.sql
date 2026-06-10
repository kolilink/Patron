-- ============================================================
-- Patron — Migration v27
-- Run in Supabase SQL Editor AFTER migration_v26
-- Adds rate limiting table for phone verification requests.
-- Prevents flooding a target phone with WhatsApp messages.
-- ============================================================

CREATE TABLE IF NOT EXISTS phone_verification_attempts (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  phone        text        NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);

-- Index for fast lookups by phone + time window
CREATE INDEX IF NOT EXISTS phone_verification_attempts_phone_time
  ON phone_verification_attempts (phone, attempted_at DESC);

ALTER TABLE phone_verification_attempts ENABLE ROW LEVEL SECURITY;
-- No direct RLS policies — accessed only via service role in Edge Function.

-- Auto-cleanup: delete attempts older than 1 hour to keep table small.
-- Uncomment after enabling pg_cron in Database → Extensions.
--
-- SELECT cron.schedule(
--   'cleanup-phone-verification-attempts',
--   '*/30 * * * *',
--   $$ DELETE FROM phone_verification_attempts WHERE attempted_at < now() - interval '1 hour'; $$
-- );
