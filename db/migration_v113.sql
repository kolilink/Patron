-- ============================================================
-- Patron — Migration v113
-- Run in Supabase SQL Editor AFTER migration_v112
--
-- Security fix: the existing OTP request rate limits (5 per 10
-- min) are scoped PER PHONE / PER EMAIL. An attacker who rotates
-- through many phone numbers or email addresses from one source
-- is not slowed down at all — and every WhatsApp/Twilio/Resend
-- message sent costs real money. This adds a secondary, coarser
-- limit scoped PER IP ADDRESS across both OTP-request endpoints,
-- to cap the blast radius of a rotation-based cost-abuse attack
-- without affecting a single legitimate user on one connection.
-- ============================================================

CREATE TABLE IF NOT EXISTS ip_verification_attempts (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  ip           text        NOT NULL,
  endpoint     text        NOT NULL, -- 'phone' | 'email'
  attempted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ip_verification_attempts_ip_time
  ON ip_verification_attempts (ip, endpoint, attempted_at DESC);

ALTER TABLE ip_verification_attempts ENABLE ROW LEVEL SECURITY;
-- No direct RLS policies — accessed only via service role in Edge Functions.
