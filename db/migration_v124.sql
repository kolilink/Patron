-- ============================================================
-- Patron — Migration v124
-- Run in Supabase SQL Editor AFTER migration_v123
--
-- Security fix: join_business's rate limiter (5 attempts / 10 minutes)
-- never actually triggers against a failing invite code guess.
--
-- The function's INSERT INTO invite_attempts happens *before* the expiry /
-- max-uses / manager-limit / duplicate-membership checks, clearly intending
-- every one of those failures to still count toward the rate limit. But
-- join_business has no internal exception handler, and a Postgres function
-- invoked by a single top-level statement is atomic: when it RAISEs
-- uncaught, the ENTIRE call rolls back — including the invite_attempts row
-- inserted earlier in that same call. Only a call that completes
-- successfully (a real join) ever actually persists its attempt row. An
-- attacker retrying wrong/expired/already-claimed codes is never
-- rate-limited no matter how many times they retry — confirmed via a real
-- integration test against a local Supabase instance (not simulated):
-- __tests__/integration/join-business.integration.test.ts.
--
-- There is no way to make a write inside one function call survive a later
-- exception in that same call without an autonomous transaction (dblink /
-- pg_background) or a second, independent round trip. Fix: split attempt
-- logging into its own RPC, record_invite_attempt(), which always commits
-- as its own top-level statement (no conditional RAISE inside it at all).
-- The client now calls it immediately before join_business() — see
-- stores/auth.ts's joinBusiness(). join_business() itself is unchanged
-- except for removing its own (ineffective) attempt-logging statements;
-- every validation check and error message is identical to migration_v80.
-- ============================================================

CREATE OR REPLACE FUNCTION public.record_invite_attempt()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Non authentifié'; END IF;

  INSERT INTO invite_attempts (user_id) VALUES (v_uid);
  DELETE FROM invite_attempts WHERE attempted_at < now() - interval '1 hour';
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_invite_attempt() TO authenticated;

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

  UPDATE invite_codes SET uses = uses + 1 WHERE id = v_invite.id;

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
