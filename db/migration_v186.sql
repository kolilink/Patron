-- ============================================================
-- Patron — Migration v186
-- Run in Supabase SQL Editor AFTER migration_v185
--
-- Adds invite-code redemption tracking (checklist 1.7's "inviter can see
-- redeemed-by/when" — an audit-trail feature for the shop owner's own
-- visibility, not a vulnerability fix; explicitly scoped down to just this
-- piece on 2026-09-27, the rest of 1.7 stays deferred).
--
-- Two columns directly on invite_codes rather than a separate redemption
-- table: every real invite code this app creates has max_uses = 1
-- (stores/equipe.ts's createCode() always sets it), so "the one redemption"
-- and "the code row" are already 1:1 in practice — a join table would add
-- normalization for a multiplicity that doesn't actually occur. If a code
-- is ever redeemed more than once (max_uses > 1, not something the current
-- UI can even create), these two columns only ever reflect the MOST RECENT
-- redemption — a known, accepted limitation given the real usage pattern,
-- not something worth a bigger schema for.
--
-- Real behavior change this depends on (made in stores/equipe.ts
-- alongside this migration, not here): fetchCodes() used to DELETE a
-- consumed code the moment the admin opened the screen — that would have
-- erased this history within one screen view of being created. Fixed to
-- only delete codes that expired WITHOUT ever being used; a consumed code
-- is now kept and surfaced as redemption history instead.
-- ============================================================

ALTER TABLE invite_codes
  ADD COLUMN IF NOT EXISTS redeemed_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS redeemed_at timestamptz;

-- join_business() reproduced from its current live definition
-- (migration_v124.sql) byte-for-byte except the one new UPDATE clause —
-- signature unchanged, so CREATE OR REPLACE is safe (no duplicate-overload
-- risk).
CREATE OR REPLACE FUNCTION public.join_business(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid               uuid := auth.uid();
  v_attempts          int;
  v_invite            record;
  v_new_membership_id uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Non authentifié'; END IF;

  SELECT COUNT(*) INTO v_attempts
  FROM invite_attempts
  WHERE user_id = v_uid
    AND attempted_at > now() - interval '10 minutes';
  IF v_attempts >= 5 THEN
    RAISE EXCEPTION 'Trop de tentatives. Réessayez dans 10 minutes.' USING ERRCODE = 'P0001';
  END IF;

  SELECT id, business_id, role, expires_at, max_uses, uses, scope_all_products, scope_product_ids
  INTO v_invite
  FROM invite_codes
  WHERE code = upper(trim(p_code))
  LIMIT 1;

  IF NOT FOUND THEN RETURN NULL; END IF;

  IF v_invite.expires_at IS NOT NULL AND v_invite.expires_at <= now() THEN
    RAISE EXCEPTION 'Ce code a expiré. Demandez un nouveau code à votre partenaire.'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_invite.max_uses IS NOT NULL AND v_invite.uses >= v_invite.max_uses THEN
    RAISE EXCEPTION 'Ce code a déjà été utilisé. Demandez un nouveau code à votre partenaire.'
      USING ERRCODE = 'P0001';
  END IF;

  IF (
    SELECT COUNT(*) FROM memberships
    WHERE user_id = v_uid AND role != 'administrateur'
  ) >= 3 THEN
    RAISE EXCEPTION 'Limite de 3 boutiques atteinte' USING ERRCODE = 'P0001';
  END IF;

  IF v_invite.role = 'manager' AND EXISTS (
    SELECT 1 FROM memberships
    WHERE business_id = v_invite.business_id AND role = 'manager'
  ) THEN
    RAISE EXCEPTION 'Cette boutique a déjà un gérant' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM memberships
    WHERE user_id = v_uid AND business_id = v_invite.business_id
  ) THEN
    RAISE EXCEPTION 'Vous êtes déjà membre de cette boutique' USING ERRCODE = '23505';
  END IF;

  -- Only new part vs. migration_v124.sql: stamp who and when.
  UPDATE invite_codes
  SET uses = uses + 1, redeemed_by = v_uid, redeemed_at = now()
  WHERE id = v_invite.id;

  INSERT INTO memberships (user_id, business_id, role, scope_all_products)
  VALUES (v_uid, v_invite.business_id, v_invite.role, v_invite.scope_all_products)
  RETURNING id INTO v_new_membership_id;

  -- Apply specific product scope when not all-products
  IF NOT v_invite.scope_all_products
     AND v_invite.scope_product_ids IS NOT NULL
     AND array_length(v_invite.scope_product_ids, 1) > 0 THEN
    INSERT INTO membership_product_scope (membership_id, product_id, contribution, profit_share)
    SELECT v_new_membership_id, unnest(v_invite.scope_product_ids), 0, 0;
  END IF;

  RETURN jsonb_build_object(
    'business_id', v_invite.business_id,
    'role',        v_invite.role
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.join_business(text) TO authenticated;
