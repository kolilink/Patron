-- ============================================================
-- Patron — Migration v46
-- Run in Supabase SQL Editor AFTER migration_v45
--
-- Improves join_business() error reporting: instead of returning
-- NULL for all failure cases (not found / expired / fully used),
-- raises distinct French exceptions for expired and used codes.
-- This lets the client show a clear reason rather than the
-- ambiguous "invalide, expiré, ou déjà utilisé" catch-all.
-- ============================================================

CREATE OR REPLACE FUNCTION join_business(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      uuid := auth.uid();
  v_attempts int;
  v_invite   record;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Non authentifié'; END IF;

  -- Rate limit: 5 attempts per 10 minutes
  SELECT COUNT(*) INTO v_attempts
  FROM invite_attempts
  WHERE user_id = v_uid
    AND attempted_at > now() - interval '10 minutes';
  IF v_attempts >= 5 THEN
    RAISE EXCEPTION 'Trop de tentatives. Réessayez dans 10 minutes.' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO invite_attempts (user_id) VALUES (v_uid);
  DELETE FROM invite_attempts WHERE attempted_at < now() - interval '1 hour';

  -- Look up by code value only — no expiry/uses filter so we can give specific errors
  SELECT id, business_id, role, expires_at, max_uses, uses
  INTO v_invite
  FROM invite_codes
  WHERE code = upper(trim(p_code))
  LIMIT 1;

  -- Code doesn't exist → return NULL (client shows "code invalide")
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- Expired → specific message
  IF v_invite.expires_at IS NOT NULL AND v_invite.expires_at <= now() THEN
    RAISE EXCEPTION 'Ce code a expiré. Demandez un nouveau code à votre partenaire.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Fully used → specific message
  IF v_invite.max_uses IS NOT NULL AND v_invite.uses >= v_invite.max_uses THEN
    RAISE EXCEPTION 'Ce code a déjà été utilisé. Demandez un nouveau code à votre partenaire.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Enforce per-user join limit (max 3 non-admin memberships)
  IF (
    SELECT COUNT(*) FROM memberships
    WHERE user_id = v_uid AND role != 'administrateur'
  ) >= 3 THEN
    RAISE EXCEPTION 'Limite de 3 boutiques atteinte' USING ERRCODE = 'P0001';
  END IF;

  -- Enforce 1 manager per business
  IF v_invite.role = 'manager' AND EXISTS (
    SELECT 1 FROM memberships
    WHERE business_id = v_invite.business_id AND role = 'manager'
  ) THEN
    RAISE EXCEPTION 'Cette boutique a déjà un gérant' USING ERRCODE = 'P0001';
  END IF;

  -- Reject duplicate membership
  IF EXISTS (
    SELECT 1 FROM memberships
    WHERE user_id = v_uid AND business_id = v_invite.business_id
  ) THEN
    RAISE EXCEPTION 'Vous êtes déjà membre de cette boutique' USING ERRCODE = '23505';
  END IF;

  -- Atomically consume the invite and create the membership
  UPDATE invite_codes SET uses = uses + 1 WHERE id = v_invite.id;
  INSERT INTO memberships (user_id, business_id, role)
  VALUES (v_uid, v_invite.business_id, v_invite.role);

  RETURN jsonb_build_object(
    'business_id', v_invite.business_id,
    'role',        v_invite.role
  );
END;
$$;

-- No GRANT needed — function name and arg signature unchanged from v43
