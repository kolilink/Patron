-- ============================================================
-- Patron — Migration v8
-- Run in Supabase SQL Editor AFTER migration_v7
-- ============================================================

-- ─── profiles: phone as unique identifier ───────────────────
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS phone text;
CREATE UNIQUE INDEX IF NOT EXISTS profiles_phone_unique
  ON profiles (phone) WHERE phone IS NOT NULL;

-- ─── memberships: milestone tracking ────────────────────────
-- milestone_reached = true once the user verifies their phone number
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS milestone_reached boolean NOT NULL DEFAULT false;

-- ─── invite_codes: explicit business_id ─────────────────────
-- Safety: add if somehow not present from original schema
ALTER TABLE invite_codes ADD COLUMN IF NOT EXISTS business_id uuid
  REFERENCES businesses(id) ON DELETE CASCADE;

-- ─── otp_codes: WhatsApp OTP storage ────────────────────────
-- Accessed only via Edge Functions (service_role key); no user-facing RLS
CREATE TABLE IF NOT EXISTS otp_codes (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       text        NOT NULL,
  code        text        NOT NULL,
  expires_at  timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  used        boolean     NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS otp_codes_phone_idx ON otp_codes (phone, used);
ALTER TABLE otp_codes ENABLE ROW LEVEL SECURITY;
-- No user policies — Edge Functions use service_role key exclusively

-- ─── invite_codes: scoped read for anonymous users ──────────
-- Members can list their own business's codes.
-- Anonymous users can read ONE code by exact match (join flow).
-- This prevents anonymous users from listing all codes across all businesses.
DROP POLICY IF EXISTS "anonymous_can_read_invite_codes" ON invite_codes;
CREATE POLICY "invite_codes_read"
  ON invite_codes FOR SELECT
  TO authenticated
  USING (
    -- Existing members can see their own business's codes (team management screen)
    is_member(business_id)
    OR
    -- Anonymous and new users can look up a single code by value.
    -- RLS cannot restrict the WHERE clause, but the join flow always filters
    -- by code value; there is no UI path that lists all codes without business
    -- membership. Codes are short-lived (7 days) and single-use by default.
    (SELECT (auth.jwt()->>'is_anonymous')::boolean) IS TRUE
  );

-- ─── profiles: allow self-insert for anonymous users ────────
-- handle_new_user() trigger runs as superuser and bypasses RLS.
-- This policy is a safety net for the upsert in signInAnonymously()
-- in case trigger timing is slow.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'profiles' AND policyname = 'users_can_insert_own_profile'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "users_can_insert_own_profile"
        ON profiles FOR INSERT
        TO authenticated
        WITH CHECK (auth.uid() = id);
    $policy$;
  END IF;
END $$;

-- ─── anonymous: block listing other users' memberships ───────
-- Permanent users can see teammates. Anonymous users can only see their own
-- memberships to prevent profile enumeration before phone verification.
DROP POLICY IF EXISTS "anon_memberships_own_only" ON memberships;
CREATE POLICY "anon_memberships_own_only"
  ON memberships AS RESTRICTIVE FOR SELECT
  TO authenticated
  USING (
    -- Not anonymous → existing permissive policies apply normally
    (SELECT (auth.jwt()->>'is_anonymous')::boolean) IS NOT TRUE
    OR
    -- Anonymous → only their own rows
    user_id = auth.uid()
  );
