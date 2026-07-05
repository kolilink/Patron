-- ============================================================
-- Patron — Migration v95
-- Run in Supabase SQL Editor AFTER migration_v94
-- Adds: business_partnerships, partner_invite_codes (single-use,
--       24h expiry), DM chat rooms, 7 SECURITY DEFINER RPCs.
-- Safe to re-run (uses IF NOT EXISTS / CREATE OR REPLACE).
-- ============================================================

-- ─── 1. Business partnerships table ──────────────────────────

CREATE TABLE IF NOT EXISTS business_partnerships (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id           UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  recipient_id           UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  status                 TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','accepted','declined','blocked')),
  requester_shares_stock BOOLEAN NOT NULL DEFAULT true,
  recipient_shares_stock BOOLEAN NOT NULL DEFAULT true,
  requester_nickname     TEXT,
  recipient_nickname     TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(requester_id, recipient_id)
);

ALTER TABLE business_partnerships ENABLE ROW LEVEL SECURITY;

-- Admin/manager of either business can read the partnership row
DROP POLICY IF EXISTS "partners_select" ON business_partnerships;
CREATE POLICY "partners_select" ON business_partnerships FOR SELECT USING (
  get_role(requester_id) IN ('administrateur','manager')
  OR get_role(recipient_id) IN ('administrateur','manager')
);

-- All writes go exclusively through SECURITY DEFINER RPCs
DROP POLICY IF EXISTS "partners_no_direct_write" ON business_partnerships;
CREATE POLICY "partners_no_direct_write" ON business_partnerships
  FOR ALL USING (false) WITH CHECK (false);

-- Real-time: so incoming requests appear live in the Amis tab
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'business_partnerships'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE business_partnerships;
  END IF;
END $$;

-- ─── 2. Partner invite codes (single-use, 24h) ───────────────

CREATE TABLE IF NOT EXISTS partner_invite_codes (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id          UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  code                 TEXT UNIQUE NOT NULL DEFAULT lower(encode(gen_random_bytes(4), 'hex')),
  expires_at           TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours'),
  used_at              TIMESTAMPTZ,
  used_by_business_id  UUID REFERENCES businesses(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS partner_invite_codes_business_valid
  ON partner_invite_codes(business_id, expires_at, used_at);

ALTER TABLE partner_invite_codes ENABLE ROW LEVEL SECURITY;

-- Only admin/manager of the owning business can see their codes
DROP POLICY IF EXISTS "invite_codes_owner_select" ON partner_invite_codes;
CREATE POLICY "invite_codes_owner_select" ON partner_invite_codes FOR SELECT USING (
  get_role(business_id) IN ('administrateur','manager')
);

-- All writes via SECURITY DEFINER RPCs
DROP POLICY IF EXISTS "invite_codes_no_direct_write" ON partner_invite_codes;
CREATE POLICY "invite_codes_no_direct_write" ON partner_invite_codes
  FOR ALL USING (false) WITH CHECK (false);

-- ─── 3. Businesses: allow seeing partner business names ──────
-- The default businesses SELECT policy is is_member(id) only.
-- Without this, loadPartnerships embedded joins return null for the partner's
-- business name (since you're not a member of their business).
DROP POLICY IF EXISTS "partenaires_voir_business" ON businesses;
CREATE POLICY "partenaires_voir_business" ON businesses FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM business_partnerships bp
    WHERE (bp.requester_id = id OR bp.recipient_id = id)
      AND bp.status IN ('pending','accepted')
      AND (
        get_role(bp.requester_id) IN ('administrateur','manager')
        OR get_role(bp.recipient_id) IN ('administrateur','manager')
      )
  )
);

-- ─── 4. DM room support on chat_rooms ─────────────────────────

ALTER TABLE chat_rooms
  ADD COLUMN IF NOT EXISTS partnership_id UUID
    REFERENCES business_partnerships(id) ON DELETE CASCADE;

-- Update chat_rooms SELECT policy to allow DM participants (admin/manager only)
DROP POLICY IF EXISTS "Lire salles accessibles" ON chat_rooms;
CREATE POLICY "Lire salles accessibles" ON chat_rooms FOR SELECT USING (
  is_global = true
  OR (business_id IS NOT NULL AND partnership_id IS NULL AND is_member(business_id))
  OR (
    partnership_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM business_partnerships bp
      WHERE bp.id = partnership_id
        AND bp.status = 'accepted'
        AND (
          get_role(bp.requester_id) IN ('administrateur','manager')
          OR get_role(bp.recipient_id) IN ('administrateur','manager')
        )
    )
  )
);

-- Update chat_messages SELECT policy to include DM rooms
DROP POLICY IF EXISTS "Lire messages de ses salles" ON chat_messages;
CREATE POLICY "Lire messages de ses salles" ON chat_messages FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM chat_rooms cr WHERE cr.id = room_id AND (
      cr.is_global = true
      OR (cr.business_id IS NOT NULL AND cr.partnership_id IS NULL AND is_member(cr.business_id))
      OR (
        cr.partnership_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM business_partnerships bp
          WHERE bp.id = cr.partnership_id
            AND bp.status = 'accepted'
            AND (
              get_role(bp.requester_id) IN ('administrateur','manager')
              OR get_role(bp.recipient_id) IN ('administrateur','manager')
            )
        )
      )
    )
  )
);

-- Update chat_messages INSERT policy (DM: admin/manager only; boutique/global: anyone)
DROP POLICY IF EXISTS "Envoyer dans ses salles" ON chat_messages;
CREATE POLICY "Envoyer dans ses salles" ON chat_messages FOR INSERT WITH CHECK (
  sender_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM chat_rooms cr WHERE cr.id = room_id AND (
      cr.is_global = true
      OR (cr.business_id IS NOT NULL AND cr.partnership_id IS NULL AND is_member(cr.business_id))
      OR (
        cr.partnership_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM business_partnerships bp
          WHERE bp.id = cr.partnership_id
            AND bp.status = 'accepted'
            AND (
              get_role(bp.requester_id) IN ('administrateur','manager')
              OR get_role(bp.recipient_id) IN ('administrateur','manager')
            )
        )
      )
    )
  )
);

-- ─── 4. RPCs ─────────────────────────────────────────────────

-- get_or_create_invite_code: returns the current valid code for this business,
-- or creates a fresh one (24h expiry). Cleans up old expired codes as a side effect.
CREATE OR REPLACE FUNCTION get_or_create_invite_code(
  p_business_id UUID
) RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role TEXT;
  v_code TEXT;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Non autorisé'; END IF;

  SELECT role INTO v_role FROM memberships
  WHERE user_id = auth.uid() AND business_id = p_business_id LIMIT 1;
  IF v_role IS NULL OR v_role NOT IN ('administrateur','manager') THEN
    RAISE EXCEPTION 'Non autorisé';
  END IF;

  -- Clean up expired / used codes for this business (keep the table lean)
  DELETE FROM partner_invite_codes
  WHERE business_id = p_business_id
    AND (expires_at <= now() OR used_at IS NOT NULL);

  -- Find an existing valid code
  SELECT code INTO v_code FROM partner_invite_codes
  WHERE business_id = p_business_id
    AND expires_at > now()
    AND used_at IS NULL
  ORDER BY created_at DESC
  LIMIT 1;

  -- None found — create a new one
  IF v_code IS NULL THEN
    INSERT INTO partner_invite_codes (business_id)
    VALUES (p_business_id)
    RETURNING code INTO v_code;
  END IF;

  RETURN v_code;
END; $$;
GRANT EXECUTE ON FUNCTION get_or_create_invite_code(UUID) TO authenticated;

-- regenerate_invite_code: force a fresh code (old one is invalidated)
CREATE OR REPLACE FUNCTION regenerate_invite_code(
  p_business_id UUID
) RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role TEXT;
  v_code TEXT;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Non autorisé'; END IF;

  SELECT role INTO v_role FROM memberships
  WHERE user_id = auth.uid() AND business_id = p_business_id LIMIT 1;
  IF v_role IS NULL OR v_role NOT IN ('administrateur','manager') THEN
    RAISE EXCEPTION 'Non autorisé';
  END IF;

  -- Expire all current valid codes immediately
  UPDATE partner_invite_codes
  SET expires_at = now()
  WHERE business_id = p_business_id AND used_at IS NULL AND expires_at > now();

  -- Create a fresh one
  INSERT INTO partner_invite_codes (business_id)
  VALUES (p_business_id)
  RETURNING code INTO v_code;

  RETURN v_code;
END; $$;
GRANT EXECUTE ON FUNCTION regenerate_invite_code(UUID) TO authenticated;

-- Drop old signature (p_partner_code → p_invite_code rename requires a DROP first)
DROP FUNCTION IF EXISTS send_partnership_request(text, uuid);
-- Also drop get_public_stock if it was created by an earlier v95 attempt
DROP FUNCTION IF EXISTS get_public_stock(text);

-- send_partnership_request: validate invite code, consume it, create partnership
CREATE OR REPLACE FUNCTION send_partnership_request(
  p_invite_code    TEXT,
  p_my_business_id UUID
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role          TEXT;
  v_code_row      RECORD;
  v_existing_id   UUID;
  v_result_id     UUID;
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

  -- Check no existing partnership (either direction)
  SELECT id INTO v_existing_id FROM business_partnerships
  WHERE (requester_id = p_my_business_id AND recipient_id = v_code_row.business_id)
     OR (requester_id = v_code_row.business_id AND recipient_id = p_my_business_id)
  LIMIT 1;
  IF v_existing_id IS NOT NULL THEN
    RAISE EXCEPTION 'Une demande ou connexion existe déjà avec cette boutique';
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

-- accept_partnership_request: recipient accepts
CREATE OR REPLACE FUNCTION accept_partnership_request(
  p_partnership_id UUID,
  p_my_business_id UUID
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_role TEXT; v_recipient_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Non autorisé'; END IF;

  SELECT role INTO v_role FROM memberships
  WHERE user_id = auth.uid() AND business_id = p_my_business_id LIMIT 1;
  IF v_role IS NULL OR v_role NOT IN ('administrateur','manager') THEN
    RAISE EXCEPTION 'Seuls les administrateurs et managers peuvent accepter des demandes';
  END IF;

  SELECT recipient_id INTO v_recipient_id FROM business_partnerships
  WHERE id = p_partnership_id AND status = 'pending';
  IF v_recipient_id IS DISTINCT FROM p_my_business_id THEN
    RAISE EXCEPTION 'Demande introuvable ou non autorisée';
  END IF;

  UPDATE business_partnerships SET status = 'accepted', updated_at = now()
  WHERE id = p_partnership_id;
END; $$;
GRANT EXECUTE ON FUNCTION accept_partnership_request(UUID, UUID) TO authenticated;

-- decline_partnership_request: recipient declines
CREATE OR REPLACE FUNCTION decline_partnership_request(
  p_partnership_id UUID,
  p_my_business_id UUID
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_role TEXT; v_recipient_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Non autorisé'; END IF;

  SELECT role INTO v_role FROM memberships
  WHERE user_id = auth.uid() AND business_id = p_my_business_id LIMIT 1;
  IF v_role IS NULL OR v_role NOT IN ('administrateur','manager') THEN
    RAISE EXCEPTION 'Non autorisé';
  END IF;

  SELECT recipient_id INTO v_recipient_id FROM business_partnerships
  WHERE id = p_partnership_id AND status = 'pending';
  IF v_recipient_id IS DISTINCT FROM p_my_business_id THEN
    RAISE EXCEPTION 'Demande introuvable ou non autorisée';
  END IF;

  UPDATE business_partnerships SET status = 'declined', updated_at = now()
  WHERE id = p_partnership_id;
END; $$;
GRANT EXECUTE ON FUNCTION decline_partnership_request(UUID, UUID) TO authenticated;

-- update_partner_settings: rename or toggle stock sharing
CREATE OR REPLACE FUNCTION update_partner_settings(
  p_partnership_id UUID,
  p_my_business_id UUID,
  p_nickname       TEXT,
  p_share_stock    BOOLEAN
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_role TEXT; v_requester UUID; v_recipient UUID;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Non autorisé'; END IF;

  SELECT role INTO v_role FROM memberships
  WHERE user_id = auth.uid() AND business_id = p_my_business_id LIMIT 1;
  IF v_role IS NULL OR v_role NOT IN ('administrateur','manager') THEN
    RAISE EXCEPTION 'Non autorisé';
  END IF;

  SELECT requester_id, recipient_id INTO v_requester, v_recipient
  FROM business_partnerships WHERE id = p_partnership_id AND status = 'accepted';
  IF v_requester IS NULL THEN RAISE EXCEPTION 'Partenariat introuvable'; END IF;

  IF p_my_business_id = v_requester THEN
    UPDATE business_partnerships
    SET requester_nickname = p_nickname, requester_shares_stock = p_share_stock, updated_at = now()
    WHERE id = p_partnership_id;
  ELSIF p_my_business_id = v_recipient THEN
    UPDATE business_partnerships
    SET recipient_nickname = p_nickname, recipient_shares_stock = p_share_stock, updated_at = now()
    WHERE id = p_partnership_id;
  ELSE
    RAISE EXCEPTION 'Vous n''êtes pas membre de ce partenariat';
  END IF;
END; $$;
GRANT EXECUTE ON FUNCTION update_partner_settings(UUID, UUID, TEXT, BOOLEAN) TO authenticated;

-- remove_partnership: delete (cascades to DM room + messages)
CREATE OR REPLACE FUNCTION remove_partnership(
  p_partnership_id UUID,
  p_my_business_id UUID
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_role TEXT; v_exists BOOLEAN;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Non autorisé'; END IF;

  SELECT role INTO v_role FROM memberships
  WHERE user_id = auth.uid() AND business_id = p_my_business_id LIMIT 1;
  IF v_role IS NULL OR v_role NOT IN ('administrateur','manager') THEN
    RAISE EXCEPTION 'Non autorisé';
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM business_partnerships
    WHERE id = p_partnership_id
      AND (requester_id = p_my_business_id OR recipient_id = p_my_business_id)
  ) INTO v_exists;
  IF NOT v_exists THEN RAISE EXCEPTION 'Partenariat introuvable'; END IF;

  DELETE FROM business_partnerships WHERE id = p_partnership_id;
END; $$;
GRANT EXECUTE ON FUNCTION remove_partnership(UUID, UUID) TO authenticated;

-- get_or_create_dm_room: find or lazily create the DM chat room for a partnership
CREATE OR REPLACE FUNCTION get_or_create_dm_room(
  p_partnership_id UUID,
  p_my_business_id UUID
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_role TEXT; v_partner_name TEXT; v_room_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Non autorisé'; END IF;

  SELECT role INTO v_role FROM memberships
  WHERE user_id = auth.uid() AND business_id = p_my_business_id LIMIT 1;
  IF v_role IS NULL OR v_role NOT IN ('administrateur','manager') THEN
    RAISE EXCEPTION 'Non autorisé';
  END IF;

  SELECT CASE WHEN bp.requester_id = p_my_business_id THEN rcpb.name ELSE rb.name END
  INTO v_partner_name
  FROM business_partnerships bp
  JOIN businesses rb   ON rb.id = bp.requester_id
  JOIN businesses rcpb ON rcpb.id = bp.recipient_id
  WHERE bp.id = p_partnership_id AND bp.status = 'accepted'
    AND (bp.requester_id = p_my_business_id OR bp.recipient_id = p_my_business_id);

  IF v_partner_name IS NULL THEN
    RAISE EXCEPTION 'Partenariat introuvable ou non accepté';
  END IF;

  SELECT id INTO v_room_id FROM chat_rooms WHERE partnership_id = p_partnership_id LIMIT 1;

  IF v_room_id IS NULL THEN
    INSERT INTO chat_rooms (name, is_global, partnership_id)
    VALUES (v_partner_name, false, p_partnership_id)
    RETURNING id INTO v_room_id;
  END IF;

  RETURN v_room_id;
END; $$;
GRANT EXECUTE ON FUNCTION get_or_create_dm_room(UUID, UUID) TO authenticated;

-- get_partner_stock: read-only catalog view (no prices, no quantities)
CREATE OR REPLACE FUNCTION get_partner_stock(
  p_partnership_id UUID,
  p_my_business_id UUID
) RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role TEXT; v_requester UUID; v_recipient UUID;
  v_is_requester BOOLEAN; v_they_share BOOLEAN;
  v_partner_biz UUID; v_partner_name TEXT; v_result JSON;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Non autorisé'; END IF;

  SELECT role INTO v_role FROM memberships
  WHERE user_id = auth.uid() AND business_id = p_my_business_id LIMIT 1;
  IF v_role IS NULL OR v_role NOT IN ('administrateur','manager') THEN
    RAISE EXCEPTION 'Non autorisé';
  END IF;

  SELECT bp.requester_id, bp.recipient_id,
    (bp.requester_id = p_my_business_id),
    CASE WHEN bp.requester_id = p_my_business_id
      THEN bp.recipient_shares_stock ELSE bp.requester_shares_stock END
  INTO v_requester, v_recipient, v_is_requester, v_they_share
  FROM business_partnerships bp
  WHERE bp.id = p_partnership_id AND bp.status = 'accepted'
    AND (bp.requester_id = p_my_business_id OR bp.recipient_id = p_my_business_id);

  IF v_requester IS NULL THEN RAISE EXCEPTION 'Partenariat introuvable'; END IF;
  IF NOT v_they_share THEN
    RAISE EXCEPTION 'Ce partenaire a désactivé le partage de stock';
  END IF;

  v_partner_biz := CASE WHEN v_is_requester THEN v_recipient ELSE v_requester END;
  SELECT name INTO v_partner_name FROM businesses WHERE id = v_partner_biz;

  SELECT json_build_object(
    'business_name', v_partner_name,
    'products', (
      SELECT json_agg(json_build_object(
        'name', p.name, 'category', p.category,
        'in_stock', p.stock_qty > 0, 'unit', p.unit
      ) ORDER BY p.category NULLS LAST, p.name)
      FROM products p
      WHERE p.business_id = v_partner_biz AND p.archived = false AND p.is_system = false
    )
  ) INTO v_result;

  RETURN v_result;
END; $$;
GRANT EXECUTE ON FUNCTION get_partner_stock(UUID, UUID) TO authenticated;
