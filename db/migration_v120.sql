-- ============================================================
-- Patron — Migration v120
-- Run in Supabase SQL Editor AFTER migration_v119
--
-- Fix: createBusiness() polled the memberships table client-side up to 5x
-- (600ms apart, ~3s worst case) waiting for the on_business_created trigger
-- to create the admin membership row. The trigger already runs in the same
-- transaction as the businesses INSERT (see schema.sql, handle_business_created),
-- so there was never an actual race to wait out — the retries were pure
-- client-side over-caution burning time on slow connections during the
-- single most important first-run action in the app (creating your shop).
--
-- Fix: one SECURITY DEFINER RPC that inserts the business, lets the existing
-- on_business_created trigger fire in the same transaction, then reads back
-- and returns the membership + business in the same round trip. No polling,
-- no second request. Re-implements the "1 business per user" check that the
-- RLS INSERT policy (migration_v29) would otherwise enforce, since a
-- SECURITY DEFINER function bypasses table RLS.
-- ============================================================

CREATE OR REPLACE FUNCTION create_business_with_membership(
  p_id       uuid,
  p_name     text,
  p_type     text,
  p_currency text,
  p_phone    text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_membership jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = 'P0001';
  END IF;

  -- Mirrors the RLS INSERT policy from migration_v29 — SECURITY DEFINER
  -- bypasses table RLS, so the 1-business-per-user limit must be re-checked here.
  IF EXISTS (
    SELECT 1 FROM memberships
    WHERE user_id = auth.uid() AND role = 'administrateur'
  ) THEN
    RAISE EXCEPTION 'Vous avez déjà un commerce actif' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO businesses (id, name, type, currency, phone, created_by)
  VALUES (p_id, p_name, p_type, p_currency, p_phone, auth.uid());
  -- on_business_created trigger fires here, inside this same transaction,
  -- inserting the admin membership row before this INSERT statement returns.

  SELECT to_jsonb(m) || jsonb_build_object('business', to_jsonb(b))
  INTO v_membership
  FROM memberships m
  JOIN businesses b ON b.id = m.business_id
  WHERE m.business_id = p_id AND m.user_id = auth.uid();

  IF v_membership IS NULL THEN
    RAISE EXCEPTION 'Échec de la création du commerce' USING ERRCODE = 'P0001';
  END IF;

  RETURN v_membership;
END;
$$;

GRANT EXECUTE ON FUNCTION create_business_with_membership(uuid, text, text, text, text) TO authenticated;
