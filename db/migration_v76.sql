-- v76: Email account recovery
-- Adds recovery_email to profiles + email_verifications/attempts tables

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS recovery_email TEXT UNIQUE;

CREATE TABLE IF NOT EXISTS email_verifications (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT        NOT NULL,
  token      TEXT        NOT NULL,
  status     TEXT        NOT NULL DEFAULT 'en_attente' CHECK (status IN ('en_attente', 'verifie')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS email_verification_attempts (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email        TEXT        NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Both tables are accessed only via service role from Edge Functions — no user policies needed.
ALTER TABLE email_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_verification_attempts ENABLE ROW LEVEL SECURITY;
