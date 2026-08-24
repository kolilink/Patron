-- ============================================================
-- Patron — Migration v157
-- Run in Supabase SQL Editor AFTER migration_v156
--
-- Founder testing tooling: the founder (is_founder(), migration_v126) needs
-- to create and delete many throwaway test businesses while iterating on
-- onboarding. The standing "1 business per administrateur" limit
-- (migration_v29's RLS policy, re-implemented inside
-- create_business_with_membership per migration_v120 since a SECURITY
-- DEFINER function bypasses table RLS) exists to stop a real merchant from
-- accidentally creating duplicate shops — it was never meant to block the
-- one person who legitimately needs many. Exempting is_founder() from that
-- check, rather than raising or removing the limit for everyone, keeps the
-- real-merchant guardrail fully intact.
--
-- delete_business() is new — there was no way to remove a business at all
-- before this (only leave-membership / delete-my-account, neither of which
-- deletes the business itself). Founder-only, same RAISE EXCEPTION 'Accès
-- refusé' pattern every other founder-gated RPC in this codebase uses —
-- this is testing cleanup, not a feature anyone else needs.
--
-- Most business_id foreign keys already cascade (see schema/migrations —
-- products, sale_orders, memberships, chat_rooms, expenses,
-- capital_injections, business_partnerships, etc.). Four don't, and are
-- cleaned up explicitly first or the delete either fails outright
-- (notification_log.business_id is NOT NULL, no cascade) or silently
-- leaves a dangling reference elsewhere (businesses.referred_by_business_id
-- self-reference, reconciliation_findings.business_id,
-- partner_invite_codes.used_by_business_id — all nullable, none cascade).
-- Once those four are handled, the businesses row itself cascades through
-- everything else.
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
  -- bypasses table RLS, so the 1-business-per-user limit must be re-checked
  -- here. The founder is exempt (see migration header above).
  IF NOT is_founder() AND EXISTS (
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

-- ─── Founder-only business deletion (test cleanup) ────────────

CREATE OR REPLACE FUNCTION delete_business(p_business_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_founder() THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM notification_log WHERE business_id = p_business_id;
  UPDATE reconciliation_findings SET business_id = NULL WHERE business_id = p_business_id;
  UPDATE businesses SET referred_by_business_id = NULL WHERE referred_by_business_id = p_business_id;
  UPDATE partner_invite_codes SET used_by_business_id = NULL WHERE used_by_business_id = p_business_id;

  -- Everything else references businesses(id) ON DELETE CASCADE and cleans
  -- up automatically from here.
  DELETE FROM businesses WHERE id = p_business_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION delete_business(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION delete_business(uuid) TO authenticated;
