-- ============================================================
-- Patron — Migration v127
-- Run in Supabase SQL Editor AFTER migration_v126
--
-- Fix: support_conversations (v126) was one shared thread per BUSINESS,
-- readable by every member (is_member(business_id)) — so if a vendeur
-- messaged the founder about a personal account issue, their own
-- administrateur/manager/teammates could read it too. Support threads must
-- be private between the individual sender and the founder, not shared with
-- the sender's whole team.
--
-- Fix: scopes each conversation to (business_id, merchant_user_id) instead
-- of business_id alone — one open thread per PERSON per business, not one
-- per business. RLS now only grants a merchant read access to a
-- conversation they personally started; is_founder() is unaffected (still
-- sees everything, across every sender and every business).
--
-- business_last_read_at is renamed to merchant_last_read_at to reflect that
-- it was always meant to be one person's read cursor, not a shared
-- team cursor — this migration is what actually makes that true.
-- ============================================================

-- ─── Schema changes ──────────────────────────────────────────

ALTER TABLE support_conversations
  ADD COLUMN IF NOT EXISTS merchant_user_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS merchant_name    text;

ALTER TABLE support_conversations
  RENAME COLUMN business_last_read_at TO merchant_last_read_at;

-- Backfill existing rows (each was previously one-per-business) from the
-- earliest merchant message in that thread, so no in-flight conversation
-- loses its owner.
UPDATE support_conversations sc
SET merchant_user_id = sub.sender_id,
    merchant_name    = sub.sender_name
FROM (
  SELECT DISTINCT ON (conversation_id) conversation_id, sender_id, sender_name
  FROM support_messages
  WHERE sender_role = 'merchant'
  ORDER BY conversation_id, created_at ASC
) sub
WHERE sc.id = sub.conversation_id
  AND sc.merchant_user_id IS NULL;

-- ─── Indexes ─────────────────────────────────────────────────

DROP INDEX IF EXISTS support_conversations_one_open_per_business;

-- At most one OPEN conversation per (business, sender) — was per business only.
CREATE UNIQUE INDEX IF NOT EXISTS support_conversations_one_open_per_sender
  ON support_conversations(business_id, merchant_user_id) WHERE status = 'open';

-- ─── RLS ─────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Membres ou fondateur: lire conversations" ON support_conversations;
DROP POLICY IF EXISTS "Membres ou fondateur: lire messages"      ON support_messages;

CREATE POLICY "Auteur ou fondateur: lire conversations"
  ON support_conversations FOR SELECT
  USING (merchant_user_id = auth.uid() OR is_founder());

CREATE POLICY "Auteur ou fondateur: lire messages"
  ON support_messages FOR SELECT
  USING (
    is_founder()
    OR EXISTS (
      SELECT 1 FROM support_conversations sc
      WHERE sc.id = conversation_id AND sc.merchant_user_id = auth.uid()
    )
  );

-- ─── RPCs (re-scoped to the caller's own thread, not the whole business) ──

CREATE OR REPLACE FUNCTION open_or_get_support_conversation(p_business_id uuid)
RETURNS support_conversations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv support_conversations;
  v_name text;
BEGIN
  IF NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_conv FROM support_conversations
  WHERE business_id = p_business_id AND merchant_user_id = auth.uid() AND status = 'open';

  IF NOT FOUND THEN
    SELECT name INTO v_name FROM profiles WHERE id = auth.uid();
    INSERT INTO support_conversations (business_id, merchant_user_id, merchant_name)
    VALUES (p_business_id, auth.uid(), COALESCE(v_name, 'Membre'))
    RETURNING * INTO v_conv;
  END IF;

  RETURN v_conv;
END;
$$;

CREATE OR REPLACE FUNCTION send_support_message(p_business_id uuid, p_content text)
RETURNS support_messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv support_conversations;
  v_msg  support_messages;
  v_name text;
BEGIN
  IF NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;
  IF length(trim(p_content)) = 0 THEN
    RAISE EXCEPTION 'Message vide' USING ERRCODE = 'P0001';
  END IF;

  v_conv := open_or_get_support_conversation(p_business_id);

  SELECT name INTO v_name FROM profiles WHERE id = auth.uid();

  IF v_conv.status = 'closed' THEN
    UPDATE support_conversations SET status = 'open' WHERE id = v_conv.id;
  END IF;

  INSERT INTO support_messages (conversation_id, business_id, sender_id, sender_role, sender_name, content)
  VALUES (v_conv.id, p_business_id, auth.uid(), 'merchant', COALESCE(v_name, 'Membre'), p_content)
  RETURNING * INTO v_msg;

  UPDATE support_conversations
  SET last_message_at = v_msg.created_at,
      last_message_preview = left(p_content, 120),
      merchant_name = COALESCE(v_name, merchant_name),
      updated_at = now()
  WHERE id = v_conv.id;

  RETURN v_msg;
END;
$$;

CREATE OR REPLACE FUNCTION mark_support_read(p_conversation_id uuid, p_as_founder boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
BEGIN
  SELECT merchant_user_id INTO v_owner FROM support_conversations WHERE id = p_conversation_id;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Conversation introuvable' USING ERRCODE = 'P0001';
  END IF;

  IF p_as_founder THEN
    IF NOT is_founder() THEN
      RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
    END IF;
    UPDATE support_conversations SET founder_last_read_at = now() WHERE id = p_conversation_id;
  ELSE
    IF v_owner != auth.uid() THEN
      RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
    END IF;
    UPDATE support_conversations SET merchant_last_read_at = now() WHERE id = p_conversation_id;
  END IF;

  RETURN true;
END;
$$;
