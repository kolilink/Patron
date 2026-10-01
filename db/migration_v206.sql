-- ============================================================
-- Patron — Migration v206
-- Run in Supabase SQL Editor AFTER migration_v205
--
-- "Inviter" — the consumer invite-a-friend journey (pre-launch
-- checklist §5). Distinct from the three invite systems that already
-- exist — team invite_codes (equipe.ts), partner_invite_codes (v95 /
-- Amis B2B), and businesses.referral_code (v130). This one is
-- person-to-person: a Patron user invites a friend who has no
-- business yet; when that friend completes phone + OTP they land in
-- Amis with the inviter already listed.
--
-- Invariant fixes (per docs/INVITE_AUDIT.md):
--   * Cryptographically secure generation — 24 random bytes (192 bits)
--     for the link token, 10 chars from a 32-char unambiguous alphabet
--     (50 bits) for the manual code. Both from gen_random_bytes()
--     (pgcrypto), never Math.random()/md5.
--   * HMAC keyed-digest storage — only HMAC-SHA256 digests of the token
--     and code are stored, never the raw secrets. The HMAC key is
--     generated HERE at migration time into app_secrets (a table with
--     no SELECT policy, readable only by SECURITY DEFINER functions
--     owned by the table owner), so the key never appears in this repo
--     and a leaked DB dump alone cannot be used to brute-force codes.
--   * Server-enforced 24h expiry — expires_at checked inside the
--     consume RPC, not just at generation.
--   * Atomic single-use — consume takes a row lock then flips
--     status='active'→'used' in one guarded UPDATE.
--   * Redemption rate limiting — reuses invite_attempts (5 / 10 min).
--   * ONE generic error for invalid/expired/revoked/reused:
--     'Invitation invalide'.
--   * Bound to inviter — inviter_id column + RLS.
--   * Redemption audit — used_by / used_at / revoked_by / revoked_at.
--   * Instant revocation — revoke_consumer_invite (inviter or founder)
--     + revoke_all_consumer_invites (founder only).
-- Safe to re-run (IF NOT EXISTS / CREATE OR REPLACE).
-- ============================================================

-- ─── 0. HMAC key vault (key never in the repo) ───────────────

CREATE TABLE IF NOT EXISTS app_secrets (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE app_secrets ENABLE ROW LEVEL SECURITY;
-- No policies at all: the table owner (and SECURITY DEFINER functions
-- owned by the table owner) bypass RLS and can read/write; every other
-- role (anon, authenticated) sees zero rows. This is what keeps the
-- HMAC key out of reach of a raw PostgREST call.

-- Generate the key once, per database. gen_random_bytes(32) = 256 bits.
INSERT INTO app_secrets (key, value)
VALUES ('invite_hmac_key', encode(gen_random_bytes(32), 'hex'))
ON CONFLICT (key) DO NOTHING;

-- ─── 1. Consumer invite rows ─────────────────────────────────

CREATE TABLE IF NOT EXISTS consumer_invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inviter_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token_hash  text UNIQUE NOT NULL,  -- HMAC-SHA256 of the link token
  code_hash   text UNIQUE NOT NULL,  -- HMAC-SHA256 of upper(trim(code))
  status      text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'revoked', 'used')),
  expires_at  timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  used_at     timestamptz,
  used_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  revoked_at  timestamptz,
  revoked_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Display name snapshot, resolved at link-generation time: the inviter's
-- personal name (profiles.name) if set, NULL when unset. Every consumer
-- (OG title, landing headline, friends list) falls back to "Ton ami".
ALTER TABLE consumer_invites ADD COLUMN IF NOT EXISTS inviter_name text;

CREATE INDEX IF NOT EXISTS consumer_invites_inviter_created
  ON consumer_invites (inviter_id, created_at DESC);

ALTER TABLE consumer_invites ENABLE ROW LEVEL SECURITY;

-- Inviter sees their own invites; the founder sees everything. No one
-- else. All writes go through the SECURITY DEFINER RPCs below.
DROP POLICY IF EXISTS "consumer_invites_select" ON consumer_invites;
CREATE POLICY "consumer_invites_select" ON consumer_invites FOR SELECT
  USING (inviter_id = auth.uid() OR is_founder());

DROP POLICY IF EXISTS "consumer_invites_no_direct_write" ON consumer_invites;
CREATE POLICY "consumer_invites_no_direct_write" ON consumer_invites
  FOR ALL USING (false) WITH CHECK (false);

-- ─── 2. Create (inviter) ─────────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_consumer_invite()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid        uuid := auth.uid();
  v_key        text;
  v_token      text;
  v_code       text;
  v_alphabet   text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; -- 32 chars, no I/L/O/U
  v_token_hash text;
  v_code_hash  text;
  v_invite_id  uuid;
  v_inviter_name text;
  v_active     int;
  v_expires    timestamptz := now() + interval '24 hours';
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Connexion requise' USING ERRCODE = 'P0001';
  END IF;

  -- Opportunistic cleanup + a soft cap so one account can't mint an
  -- unbounded pile of live single-use links.
  DELETE FROM consumer_invites
   WHERE inviter_id = v_uid AND status = 'active' AND expires_at <= now();

  SELECT count(*) INTO v_active
    FROM consumer_invites
   WHERE inviter_id = v_uid AND status = 'active';
  IF v_active >= 50 THEN
    RAISE EXCEPTION 'Trop d''invitations actives. Réessayez plus tard.' USING ERRCODE = 'P0001';
  END IF;

  v_key := (SELECT value FROM app_secrets WHERE key = 'invite_hmac_key');
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'Invitation invalide' USING ERRCODE = 'P0001';
  END IF;

  -- Link token: 24 random bytes as hex = 48 URL-safe chars, 192 bits.
  v_token := encode(gen_random_bytes(24), 'hex');

  -- Manual code: 10 chars, 50 bits. 32 divides 256 so `byte % 32` on a
  -- uniform byte has no modulo bias (same reasoning as the team-code
  -- generator in stores/equipe.ts).
  v_code := '';
  FOR _i IN 1..10 LOOP
    v_code := v_code || substr(v_alphabet, (get_byte(gen_random_bytes(1), 0) % 32) + 1, 1);
  END LOOP;

  v_token_hash := encode(hmac(convert_to(v_token, 'utf8'), convert_to(v_key, 'utf8'), 'sha256'), 'hex');
  v_code_hash  := encode(hmac(convert_to(upper(v_code), 'utf8'), convert_to(v_key, 'utf8'), 'sha256'), 'hex');

  -- Display name resolved at link-generation time (follow-up): the full
  -- personal name, or NULL so consumers can fall back to "Ton ami".
  SELECT NULLIF(btrim(COALESCE(name, '')), '') INTO v_inviter_name
    FROM profiles WHERE id = v_uid;

  v_invite_id := gen_random_uuid();
  INSERT INTO consumer_invites (id, inviter_id, token_hash, code_hash, status, expires_at, inviter_name)
  VALUES (v_invite_id, v_uid, v_token_hash, v_code_hash, 'active', v_expires, v_inviter_name);

  -- Raw secrets returned exactly once, to the creator only.
  RETURN jsonb_build_object(
    'id',         v_invite_id,
    'token',      v_token,
    'code',       v_code,
    'expires_at', v_expires
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_consumer_invite() TO authenticated;

-- ─── 3. Resolve / consume (the invited friend) ───────────────

CREATE OR REPLACE FUNCTION public.resolve_consumer_invite(
  p_token text,
  p_code  text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid         uuid := auth.uid();
  v_key         text;
  v_token_hash  text;
  v_code_hash   text;
  v_invite      record;
  v_attempts    int;
  v_inviter_name text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Connexion requise' USING ERRCODE = 'P0001';
  END IF;
  IF (p_token IS NULL OR length(btrim(p_token)) = 0)
     AND (p_code IS NULL OR length(btrim(p_code)) = 0) THEN
    RAISE EXCEPTION 'Invitation invalide' USING ERRCODE = 'P0001';
  END IF;

  -- Rate limit: 5 attempts per 10 minutes (reuses invite_attempts). The
  -- attempt row itself is recorded by the CLIENT via record_invite_attempt()
  -- BEFORE calling this function (same fix as migration_v124): a failed
  -- guess raises inside this function, and a raise rolls back the entire
  -- top-level call — including any INSERT here. Recording the attempt as its
  -- own top-level call is the only way the rate limit actually fires on
  -- wrong/expired/revoked/reused guesses. Only the count check lives here.
  SELECT count(*) INTO v_attempts
    FROM invite_attempts
   WHERE user_id = v_uid
     AND attempted_at > now() - interval '10 minutes';
  IF v_attempts >= 5 THEN
    RAISE EXCEPTION 'Trop de tentatives. Réessayez dans 10 minutes.' USING ERRCODE = 'P0001';
  END IF;

  v_key := (SELECT value FROM app_secrets WHERE key = 'invite_hmac_key');
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'Invitation invalide' USING ERRCODE = 'P0001';
  END IF;

  IF p_token IS NOT NULL AND length(btrim(p_token)) > 0 THEN
    v_token_hash := encode(hmac(convert_to(btrim(p_token), 'utf8'), convert_to(v_key, 'utf8'), 'sha256'), 'hex');
  END IF;
  IF p_code IS NOT NULL AND length(btrim(p_code)) > 0 THEN
    v_code_hash := encode(hmac(convert_to(upper(btrim(p_code)), 'utf8'), convert_to(v_key, 'utf8'), 'sha256'), 'hex');
  END IF;

  SELECT * INTO v_invite
    FROM consumer_invites
   WHERE (v_token_hash IS NOT NULL AND token_hash = v_token_hash)
      OR (v_code_hash  IS NOT NULL AND code_hash  = v_code_hash)
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation invalide' USING ERRCODE = 'P0001';
  END IF;

  -- A user can't redeem their own invite.
  IF v_invite.inviter_id = v_uid THEN
    RAISE EXCEPTION 'Invitation invalide' USING ERRCODE = 'P0001';
  END IF;

  IF v_invite.status = 'used' THEN
    IF v_invite.used_by = v_uid THEN
      -- Already connected to this inviter — idempotent success for a
      -- re-fired deep link on the same device, not an error.
      v_inviter_name := COALESCE(NULLIF(v_invite.inviter_name, ''), 'Ton ami');
      RETURN jsonb_build_object('inviter_id', v_invite.inviter_id, 'inviter_name', v_inviter_name);
    ELSE
      RAISE EXCEPTION 'Invitation invalide' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF v_invite.status <> 'active' OR v_invite.expires_at <= now() THEN
    RAISE EXCEPTION 'Invitation invalide' USING ERRCODE = 'P0001';
  END IF;

  UPDATE consumer_invites
     SET status = 'used', used_at = now(), used_by = v_uid
   WHERE id = v_invite.id
     AND status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation invalide' USING ERRCODE = 'P0001';
  END IF;

  v_inviter_name := COALESCE(NULLIF(v_invite.inviter_name, ''), 'Ton ami');
  RETURN jsonb_build_object('inviter_id', v_invite.inviter_id, 'inviter_name', v_inviter_name);
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_consumer_invite(text, text) TO authenticated;

-- ─── 4. Preview (edge function — og:title / landing page) ───
-- Non-destructive. Returns the inviter's display name (the
-- link-generation-time snapshot) only when the invite is live,
-- otherwise a generic fallback. No sensitive data.

CREATE OR REPLACE FUNCTION public.preview_consumer_invite(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key        text;
  v_token_hash text;
  v_row        record;
BEGIN
  IF p_token IS NULL OR length(btrim(p_token)) = 0 THEN
    RETURN jsonb_build_object('valid', false, 'inviter_name', null);
  END IF;

  v_key := (SELECT value FROM app_secrets WHERE key = 'invite_hmac_key');
  IF v_key IS NULL THEN
    RETURN jsonb_build_object('valid', false, 'inviter_name', null);
  END IF;

  v_token_hash := encode(hmac(convert_to(btrim(p_token), 'utf8'), convert_to(v_key, 'utf8'), 'sha256'), 'hex');

  SELECT status, expires_at, inviter_name INTO v_row
    FROM consumer_invites
   WHERE token_hash = v_token_hash
   LIMIT 1;

  IF NOT FOUND OR v_row.status <> 'active' OR v_row.expires_at <= now() THEN
    RETURN jsonb_build_object('valid', false, 'inviter_name', null);
  END IF;

  -- Full personal name snapshot; consumers fall back to "Ton ami".
  RETURN jsonb_build_object('valid', true, 'inviter_name', COALESCE(NULLIF(v_row.inviter_name, ''), NULL));
END;
$$;

GRANT EXECUTE ON FUNCTION public.preview_consumer_invite(text) TO anon, authenticated, service_role;

-- ─── 5. List my invites (Phase 6 hygiene UI) ─────────────────

CREATE OR REPLACE FUNCTION public.list_my_consumer_invites()
RETURNS TABLE (
  id            uuid,
  status        text,
  created_at    timestamptz,
  expires_at    timestamptz,
  used_at       timestamptz,
  used_by       uuid,
  used_by_name  text,
  revoked_at    timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT ci.id, ci.status, ci.created_at, ci.expires_at, ci.used_at,
         ci.used_by, COALESCE(NULLIF(p.name, ''), 'Ton ami'), ci.revoked_at
    FROM consumer_invites ci
    LEFT JOIN profiles p ON p.id = ci.used_by
   WHERE ci.inviter_id = auth.uid()
   ORDER BY ci.created_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.list_my_consumer_invites() TO authenticated;

-- ─── 6. Friends (Phase 5 — "Vous a invité · à l'instant") ───
-- Derived straight from consumer_invites: every invite I redeemed means
-- the inviter is now my friend. No separate friendship table needed.

CREATE OR REPLACE FUNCTION public.list_my_consumer_friends()
RETURNS TABLE (
  id          uuid,
  friend_id   uuid,
  friend_name text,
  invited_at  timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  -- Display name resolved at link-generation time (inviter_name snapshot)
  -- with the "Ton ami" fallback for an unset personal name.
  SELECT ci.id, ci.inviter_id,
         COALESCE(NULLIF(ci.inviter_name, ''), 'Ton ami'), ci.used_at
    FROM consumer_invites ci
   WHERE ci.used_by = auth.uid()
   ORDER BY ci.used_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.list_my_consumer_friends() TO authenticated;

-- ─── 7. Revoke one (inviter or founder) ─────────────────────

CREATE OR REPLACE FUNCTION public.revoke_consumer_invite(p_invite_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE consumer_invites
     SET status = 'revoked', revoked_at = now(), revoked_by = auth.uid()
   WHERE id = p_invite_id
     AND status = 'active'
     AND (inviter_id = auth.uid() OR is_founder());
  RETURN FOUND;
END;
$$;

GRANT EXECUTE ON FUNCTION public.revoke_consumer_invite(uuid) TO authenticated;

-- ─── 8. Revoke all (founder only) ────────────────────────────

CREATE OR REPLACE FUNCTION public.revoke_all_consumer_invites()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int;
BEGIN
  IF NOT is_founder() THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  WITH updated AS (
    UPDATE consumer_invites
       SET status = 'revoked', revoked_at = now(), revoked_by = auth.uid()
     WHERE status = 'active'
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM updated;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.revoke_all_consumer_invites() TO authenticated;
