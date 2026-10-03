-- ============================================================
-- Patron — Migration v216
-- Run in Supabase SQL Editor AFTER migration_v215.
--
-- "INVITE LOOP" (Batch B) — server half. Three redefinitions,
-- all CREATE OR REPLACE (safe to re-run):
--
--   1. list_my_consumer_friends() — B1. Was single-direction
--      (WHERE used_by = auth.uid()), so only the joiner saw the
--      inviter in Amis; the inviter NEVER saw the joiner. Now
--      bidirectional via UNION ALL:
--        leg (a) rows I redeemed  → the inviter is my friend
--        leg (b) rows redeemed by me → the joiner is my friend
--      (joiner name resolved from profiles.name at read time).
--
--   2. resolve_consumer_invite() — B3. Same logic as v214 (incl.
--      CODE-in-p_token slot) but now returns `newly_used` so the
--      client can tell a FRESH redemption (→ route to Amis + push
--      the inviter) from an idempotent re-fire of a deep link on
--      the same device (→ clear token, stay put).
--
--   3. send_partnership_request() — B4. A declined partnership was
--      a permanent block (the ANY-direction existence check raised
--      forever). Now a decline re-arms after a 7-day cooldown: a
--      stale 'declined' row is deleted and a fresh pending request
--      is inserted; a decline newer than 7 days raises a cooldown
--      error; accepted/blocked/pending still block as before.
-- ============================================================

-- ─── 1. Friends — bidirectional (B1) ─────────────────────────

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
  -- leg (a): every invite I redeemed — the inviter is my friend.
  SELECT ci.id AS id, ci.inviter_id AS friend_id,
         COALESCE(NULLIF(ci.inviter_name, ''), 'Ton ami') AS friend_name,
         ci.used_at AS invited_at
    FROM consumer_invites ci
   WHERE ci.used_by = auth.uid()
  UNION ALL
  -- leg (b): every invite of mine that was redeemed — the joiner is
  -- my friend (B1: the inviter finally sees who joined). Name is the
  -- joiner's live profiles.name, falling back to "Ton ami".
  SELECT ci.id AS id, ci.used_by AS friend_id,
         COALESCE(NULLIF(p.name, ''), 'Ton ami') AS friend_name,
         ci.used_at AS invited_at
    FROM consumer_invites ci
    LEFT JOIN profiles p ON p.id = ci.used_by
   WHERE ci.inviter_id = auth.uid()
     AND ci.status = 'used'
     AND ci.used_by IS NOT NULL
  ORDER BY invited_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.list_my_consumer_friends() TO authenticated;

-- ─── 2. Resolve — add newly_used (B3) ─────────────────────────

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
      -- re-fired deep link on the same device, not an error. newly_used
      -- = false so the client clears the pending token WITHOUT routing to
      -- Amis or re-firing the "un ami t'a rejoint" push (B3).
      v_inviter_name := COALESCE(NULLIF(v_invite.inviter_name, ''), 'Ton ami');
      RETURN jsonb_build_object(
        'inviter_id',   v_invite.inviter_id,
        'inviter_name', v_inviter_name,
        'newly_used',   false
      );
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
  RETURN jsonb_build_object(
    'inviter_id',   v_invite.inviter_id,
    'inviter_name', v_inviter_name,
    'newly_used',   true
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_consumer_invite(text, text) TO authenticated;

-- ─── 3. send_partnership_request — 7-day decline cooldown (B4) ─

CREATE OR REPLACE FUNCTION send_partnership_request(
  p_invite_code    TEXT,
  p_my_business_id UUID
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role            TEXT;
  v_code_row        RECORD;
  v_existing        RECORD;
  v_result_id       UUID;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Non autorisé'; END IF;

  SELECT role INTO v_role FROM memberships
  WHERE user_id = auth.uid() AND business_id = p_my_business_id LIMIT 1;
  IF v_role IS NULL OR v_role NOT IN ('administrateur','manager') THEN
    RAISE EXCEPTION 'Seuls les administrateurs et managers peuvent inviter des partenaires';
  END IF;

  -- Look up the invite code
  SELECT * INTO v_code_row FROM partner_invite_codes
  WHERE code = p_invite_code LIMIT 1;

  IF v_code_row IS NULL THEN
    RAISE EXCEPTION 'Code invalide';
  END IF;
  IF v_code_row.used_at IS NOT NULL THEN
    RAISE EXCEPTION 'Ce code a déjà été utilisé';
  END IF;
  IF v_code_row.expires_at <= now() THEN
    RAISE EXCEPTION 'Ce code a expiré — demandez un nouveau code à votre ami';
  END IF;
  IF v_code_row.business_id = p_my_business_id THEN
    RAISE EXCEPTION 'Vous ne pouvez pas vous ajouter vous-même';
  END IF;

  -- Existing partnership check (either direction). A 'declined' row re-arms
  -- after a 7-day cooldown (B4): the stale decline is deleted and a fresh
  -- pending request is inserted. A decline newer than 7 days raises a
  -- cooldown error; accepted/blocked/pending still block outright.
  SELECT id, status, updated_at INTO v_existing FROM business_partnerships
  WHERE (requester_id = p_my_business_id AND recipient_id = v_code_row.business_id)
     OR (requester_id = v_code_row.business_id AND recipient_id = p_my_business_id)
  LIMIT 1;

  IF v_existing.id IS NOT NULL THEN
    IF v_existing.status = 'declined' AND v_existing.updated_at < now() - interval '7 days' THEN
      -- Cooldown elapsed — delete the stale decline and re-request.
      DELETE FROM business_partnerships WHERE id = v_existing.id;
    ELSIF v_existing.status = 'declined' THEN
      RAISE EXCEPTION 'Cette boutique a refusé votre demande. Vous pourrez réessayer dans 7 jours.';
    ELSE
      RAISE EXCEPTION 'Une demande ou connexion existe déjà avec cette boutique';
    END IF;
  END IF;

  -- Consume the code (single-use)
  UPDATE partner_invite_codes
  SET used_at = now(), used_by_business_id = p_my_business_id
  WHERE id = v_code_row.id;

  -- Create the partnership request
  INSERT INTO business_partnerships (requester_id, recipient_id)
  VALUES (p_my_business_id, v_code_row.business_id)
  RETURNING id INTO v_result_id;

  RETURN v_result_id;
END; $$;
GRANT EXECUTE ON FUNCTION send_partnership_request(TEXT, UUID) TO authenticated;
