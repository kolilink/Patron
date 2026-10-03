-- ============================================================
-- Patron — Migration v214
-- Run in Supabase SQL Editor AFTER migration_v213 (supplier guard).
--
-- "INVITE PAGE REFRESH" — web-only follow-up. Two additions, both
-- server-side (no app changes):
--
--   1. preview_consumer_invite_code(p_code) — the non-destructive
--      preview twin of preview_consumer_invite(p_token), but keyed on
--      the 10-char manual CODE instead of the link token. Used by the
--      landing page to resolve the inviter's display name for the new
--      /invite/<CODE> link form. Returns only {valid, inviter_name}
--      for a live, unexpired invite — never the raw token, never any
--      sensitive data. Same security posture as the token preview.
--
--   2. resolve_consumer_invite() — extended so that a CODE supplied
--      in the p_token slot still resolves. The app always passes the
--      one credential string it captured as p_token and leaves p_code
--      empty (see app/invite.tsx + stores/inviter.ts); the new path
--      /invite/<CODE> is carried to the app as ?t=<CODE>, so the
--      server must accept a code where the app places it. The 50-bit
--      code is already the rate-limited manual entry surface, so
--      accepting it in the token slot adds no new brute-force surface.
--
-- Safe to re-run (CREATE OR REPLACE). Preserves v206 semantics.
-- ============================================================

-- ─── 1. Preview by CODE (anon, non-destructive) ─────────────

CREATE OR REPLACE FUNCTION public.preview_consumer_invite_code(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_key      text;
  v_code_hash text;
  v_row      record;
BEGIN
  IF p_code IS NULL OR length(btrim(p_code)) = 0 THEN
    RETURN jsonb_build_object('valid', false, 'inviter_name', null);
  END IF;

  v_key := (SELECT value FROM app_secrets WHERE key = 'invite_hmac_key');
  IF v_key IS NULL THEN
    RETURN jsonb_build_object('valid', false, 'inviter_name', null);
  END IF;

  -- Codes are case-insensitive: same upper(trim()) canonicalisation as
  -- the HMAC digest in create_consumer_invite() / resolve_consumer_invite().
  v_code_hash := encode(hmac(convert_to(upper(btrim(p_code)), 'utf8'), convert_to(v_key, 'utf8'), 'sha256'), 'hex');

  SELECT status, expires_at, inviter_name INTO v_row
    FROM consumer_invites
   WHERE code_hash = v_code_hash
   LIMIT 1;

  IF NOT FOUND OR v_row.status <> 'active' OR v_row.expires_at <= now() THEN
    RETURN jsonb_build_object('valid', false, 'inviter_name', null);
  END IF;

  -- Full personal name snapshot; consumers fall back to "Ton ami".
  RETURN jsonb_build_object('valid', true, 'inviter_name', COALESCE(NULLIF(v_row.inviter_name, ''), NULL));
END;
$$;

GRANT EXECUTE ON FUNCTION public.preview_consumer_invite_code(text) TO anon, authenticated, service_role;

-- ─── 2. Resolve: accept a CODE in the p_token slot ──────────

CREATE OR REPLACE FUNCTION public.resolve_consumer_invite(
  p_token text,
  p_code  text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_uid           uuid := auth.uid();
  v_key           text;
  v_token_hash    text;
  v_code_hash     text;
  v_code_hash_tok text;  -- upper(p_token) — supports /invite/<CODE> via ?t=<CODE>
  v_invite        record;
  v_attempts      int;
  v_inviter_name  text;
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
    -- v212: the app always places its one captured credential in p_token;
    -- accept a 10-char CODE there so /invite/<CODE> resolves identically.
    v_code_hash_tok := encode(hmac(convert_to(upper(btrim(p_token)), 'utf8'), convert_to(v_key, 'utf8'), 'sha256'), 'hex');
  END IF;
  IF p_code IS NOT NULL AND length(btrim(p_code)) > 0 THEN
    v_code_hash := encode(hmac(convert_to(upper(btrim(p_code)), 'utf8'), convert_to(v_key, 'utf8'), 'sha256'), 'hex');
  END IF;

  SELECT * INTO v_invite
    FROM consumer_invites
   WHERE (v_token_hash    IS NOT NULL AND token_hash = v_token_hash)
      OR (v_code_hash     IS NOT NULL AND code_hash  = v_code_hash)
      OR (v_code_hash_tok IS NOT NULL AND code_hash  = v_code_hash_tok)
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
