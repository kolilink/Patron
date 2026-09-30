-- ============================================================
-- Patron — Migration v197
-- Run in Supabase SQL Editor AFTER migration_v196
--
-- First-run hero action: a new business is asked one real question right
-- after "Ouvrir mon commerce" — "Qui vous doit de l'argent ?" — instead of
-- landing on an empty dashboard. Soft gate, per business, not per account:
-- persisted as a single nullable timestamp rather than a boolean so it also
-- doubles as a "when" for anyone who ever needs to audit it.
--
-- Backfill is the load-bearing part of this migration, not an afterthought:
-- every business that already existed before this shipped must never see
-- this gate retroactively — it's a first-run flow, not something to spring
-- on an established shop the next time its admin opens the app. Stamping
-- every pre-existing row to now() here achieves that with no client-side
-- "is this an old business" heuristic needed at all.
-- ============================================================

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS first_run_hero_completed_at timestamptz;

UPDATE businesses
SET first_run_hero_completed_at = now()
WHERE first_run_hero_completed_at IS NULL;

-- join_business() reproduced from its current live definition
-- (migration_v194.sql) byte-for-byte except one new UPDATE clause —
-- signature unchanged, so CREATE OR REPLACE is safe. The stamp here is
-- what protects an invited member from ever seeing the gate: a manager or
-- vendeur never creates a business, they only ever arrive via this
-- function, so marking the business "done" the instant anyone joins it
-- covers every non-owner path in one place, including the race where an
-- admin shares an invite code before ever completing (or skipping) the
-- gate themselves.
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

  UPDATE invite_codes
  SET uses = uses + 1, redeemed_by = v_uid, redeemed_at = now()
  WHERE id = v_invite.id;

  -- Only new part vs. migration_v194.sql: an invited member never owns the
  -- ledger, so the first-run hero gate is never relevant to them — and
  -- marking it here (idempotent via the WHERE clause) also protects the
  -- creator's own gate from ever being skipped by someone else's action:
  -- it only ever moves NULL -> now(), never overwrites an already-set value.
  UPDATE businesses
  SET first_run_hero_completed_at = now()
  WHERE id = v_invite.business_id AND first_run_hero_completed_at IS NULL;

  INSERT INTO memberships (user_id, business_id, role, scope_all_products)
  VALUES (v_uid, v_invite.business_id, v_invite.role, v_invite.scope_all_products)
  RETURNING id INTO v_new_membership_id;

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
