-- ============================================================
-- Patron — Migration v43
-- Fixes C1+C2: close the memberships INSERT bypass.
-- The old INSERT policy allowed any authenticated user who
-- knew a business_id UUID to add themselves as any role,
-- including administrateur, without an invite code.
-- This migration:
--   1. Drops the open INSERT policy on memberships.
--   2. Creates join_business() — a SECURITY DEFINER RPC that
--      validates the invite code AND inserts the membership
--      atomically. This is now the only way to join a business.
-- Note: handle_business_created is a SECURITY DEFINER trigger
-- that bypasses RLS and continues to work unaffected.
-- ============================================================

-- 1. Drop the permissive INSERT policy
DROP POLICY IF EXISTS "Adhésion propre uniquement" ON memberships;

-- 2. Atomic join RPC — validate invite + insert membership in one transaction
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

  -- Rate limit: 5 attempts per 10 minutes (reuses existing invite_attempts table)
  SELECT COUNT(*) INTO v_attempts
  FROM invite_attempts
  WHERE user_id = v_uid
    AND attempted_at > now() - interval '10 minutes';
  IF v_attempts >= 5 THEN
    RAISE EXCEPTION 'Trop de tentatives. Réessayez dans 10 minutes.' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO invite_attempts (user_id) VALUES (v_uid);
  DELETE FROM invite_attempts WHERE attempted_at < now() - interval '1 hour';

  -- Find valid invite code
  SELECT id, business_id, role, expires_at, max_uses, uses
  INTO v_invite
  FROM invite_codes
  WHERE code = upper(trim(p_code))
    AND (expires_at IS NULL OR expires_at > now())
    AND (max_uses IS NULL OR uses < max_uses)
  LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;

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

  -- Reject duplicate membership (ERRCODE matches Postgres unique_violation so
  -- the client-side '23505' duplicate check continues to work)
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

GRANT EXECUTE ON FUNCTION join_business(text) TO authenticated;
