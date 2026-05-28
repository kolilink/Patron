-- ============================================================
-- Patron — Migration v9
-- Run in Supabase SQL Editor AFTER migration_v8
-- ============================================================

-- ─── phone_verifications: inbound WhatsApp auth tokens ──────
-- Replaces otp_codes for the new zero-cost inbound flow.
-- The client generates a "Patron-XXXXXX" token, saves it here,
-- then the user sends it to our Twilio WhatsApp number.
-- Twilio Studio calls the whatsapp-inbound-webhook Edge Function
-- which flips status to 'verifie' — client subscribes via Realtime.

CREATE TABLE IF NOT EXISTS phone_verifications (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  phone       text        NOT NULL,
  token       text        NOT NULL,
  status      text        NOT NULL DEFAULT 'en_attente'
                          CHECK (status IN ('en_attente', 'verifie')),
  expires_at  timestamptz NOT NULL DEFAULT (now() + interval '5 minutes'),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Index for the webhook lookup: phone + token + status + expiry
CREATE INDEX IF NOT EXISTS phone_verifications_lookup_idx
  ON phone_verifications (phone, token, status, expires_at);

ALTER TABLE phone_verifications ENABLE ROW LEVEL SECURITY;

-- Authenticated users (including anonymous) can read their own rows.
-- This is required for the Realtime subscription in the app to receive
-- the status update when Twilio confirms the inbound message.
CREATE POLICY "users_read_own_verifications"
  ON phone_verifications FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- No INSERT/UPDATE policies — all writes go through Edge Functions
-- using the service_role key, which bypasses RLS.

-- ─── Enable Realtime on phone_verifications ──────────────────
-- The app subscribes to UPDATE events on this table to detect
-- when the webhook flips status to 'verifie'.
ALTER PUBLICATION supabase_realtime ADD TABLE phone_verifications;
