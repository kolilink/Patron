-- ============================================================
-- Patron — Migration v126
-- Run in Supabase SQL Editor AFTER migration_v125
--
-- In-app support chat: merchants message the founder (Sebastiao) directly
-- inside the app instead of WhatsApp. Human-in-the-loop only — an AI draft
-- table exists for a founder-only reply assistant (wired in a later
-- migration/edge function), but nothing here lets AI output reach a
-- merchant unsupervised: the only INSERT path for a founder-authored
-- message is send_founder_support_reply(), callable only from a real
-- founder session.
--
-- Founder identity is a global phone match on profiles.phone, not a
-- per-business role — Sebastiao is also an administrateur of one of his
-- own businesses ("Maillot Commerce"), so is_founder() must not depend on
-- any memberships row. Phone comparison strips non-digits on both sides
-- since Supabase Auth may or may not store the leading '+'.
-- ============================================================

-- ─── Founder identity helper ─────────────────────────────────

CREATE OR REPLACE FUNCTION is_founder()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
      AND regexp_replace(COALESCE(phone, ''), '\D', '', 'g') = '12672421843'
  );
$$;

GRANT EXECUTE ON FUNCTION is_founder() TO authenticated;

-- Reverse lookup used by dispatch-notification (service role) to resolve the
-- founder's own profile id for push routing — is_founder() only answers
-- "is the current caller the founder", this answers "who is the founder".
-- Returns no sensitive data beyond the id itself already implied by
-- FOUNDER_EMAIL/the phone number hardcoded server-side elsewhere.
CREATE OR REPLACE FUNCTION get_founder_id()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT id FROM profiles
  WHERE regexp_replace(COALESCE(phone, ''), '\D', '', 'g') = '12672421843'
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION get_founder_id() TO authenticated, service_role;

-- ─── Tables ──────────────────────────────────────────────────

-- One open conversation per business (not a multi-ticket system) — mirrors
-- the existing "one boutique chat room per business" precedent. A new
-- merchant message reopens a closed conversation instead of starting a new row.
CREATE TABLE IF NOT EXISTS support_conversations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id            uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  status                 text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  last_message_at        timestamptz NOT NULL DEFAULT now(),
  last_message_preview   text,
  founder_last_read_at   timestamptz,
  business_last_read_at  timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- Enforced at the DB level (not just in the RPC) so a race between two
-- concurrent open_or_get calls can't create two open rows for one business.
CREATE UNIQUE INDEX IF NOT EXISTS support_conversations_one_open_per_business
  ON support_conversations(business_id) WHERE status = 'open';

CREATE INDEX IF NOT EXISTS support_conversations_founder_list
  ON support_conversations(status, last_message_at DESC);

CREATE TABLE IF NOT EXISTS support_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
  business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  sender_id       uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  sender_role     text NOT NULL CHECK (sender_role IN ('merchant', 'founder')),
  sender_name     text NOT NULL,
  content         text NOT NULL CHECK (length(trim(content)) > 0),
  used_ai_draft   boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS support_messages_conv_created
  ON support_messages(conversation_id, created_at);

-- Founder-only AI draft suggestions. Deliberately its own table (not a
-- column on support_conversations) so founder-only visibility is a
-- schema-level guarantee via RLS, not something a screen has to remember
-- to filter — a leak here would require an actual RLS bug.
CREATE TABLE IF NOT EXISTS support_ai_drafts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id      uuid NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
  based_on_message_id  uuid REFERENCES support_messages(id) ON DELETE SET NULL,
  draft_content        text,
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
  error_note           text,
  model                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS support_ai_drafts_conv
  ON support_ai_drafts(conversation_id, created_at DESC);

-- ─── RLS ─────────────────────────────────────────────────────

ALTER TABLE support_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_messages      ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_ai_drafts     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Membres ou fondateur: lire conversations" ON support_conversations;
DROP POLICY IF EXISTS "Membres ou fondateur: lire messages"      ON support_messages;
DROP POLICY IF EXISTS "Fondateur uniquement: lire drafts"        ON support_ai_drafts;

-- No client INSERT/UPDATE policies on any of the three tables — every write
-- goes through the SECURITY DEFINER RPCs below, matching the submit_sale/
-- join_business philosophy so sender_role/sender_name are trustworthy
-- server-stamped values, not caller-supplied.

CREATE POLICY "Membres ou fondateur: lire conversations"
  ON support_conversations FOR SELECT
  USING (is_member(business_id) OR is_founder());

CREATE POLICY "Membres ou fondateur: lire messages"
  ON support_messages FOR SELECT
  USING (is_member(business_id) OR is_founder());

CREATE POLICY "Fondateur uniquement: lire drafts"
  ON support_ai_drafts FOR SELECT
  USING (is_founder());

-- The founder inbox lists conversations across every business — it needs the
-- business name to render a usable list. The existing businesses SELECT
-- policy ("Membres: voir leur commerce") only covers members; this is an
-- additive permissive policy (RLS OR's multiple SELECT policies together),
-- so it only ever widens founder access, never narrows member access.
DROP POLICY IF EXISTS "Fondateur: lire tous les commerces" ON businesses;
CREATE POLICY "Fondateur: lire tous les commerces"
  ON businesses FOR SELECT
  USING (is_founder());

-- ─── RPCs ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION open_or_get_support_conversation(p_business_id uuid)
RETURNS support_conversations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv support_conversations;
BEGIN
  IF NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_conv FROM support_conversations
  WHERE business_id = p_business_id AND status = 'open';

  IF NOT FOUND THEN
    INSERT INTO support_conversations (business_id)
    VALUES (p_business_id)
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

  IF v_conv.status = 'closed' THEN
    UPDATE support_conversations SET status = 'open' WHERE id = v_conv.id;
  END IF;

  SELECT name INTO v_name FROM profiles WHERE id = auth.uid();

  INSERT INTO support_messages (conversation_id, business_id, sender_id, sender_role, sender_name, content)
  VALUES (v_conv.id, p_business_id, auth.uid(), 'merchant', COALESCE(v_name, 'Membre'), p_content)
  RETURNING * INTO v_msg;

  UPDATE support_conversations
  SET last_message_at = v_msg.created_at,
      last_message_preview = left(p_content, 120),
      updated_at = now()
  WHERE id = v_conv.id;

  RETURN v_msg;
END;
$$;

CREATE OR REPLACE FUNCTION send_founder_support_reply(
  p_conversation_id uuid,
  p_content         text,
  p_used_ai_draft   boolean DEFAULT false
)
RETURNS support_messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_biz uuid;
  v_msg support_messages;
BEGIN
  IF NOT is_founder() THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;
  IF length(trim(p_content)) = 0 THEN
    RAISE EXCEPTION 'Message vide' USING ERRCODE = 'P0001';
  END IF;

  SELECT business_id INTO v_biz FROM support_conversations WHERE id = p_conversation_id;
  IF v_biz IS NULL THEN
    RAISE EXCEPTION 'Conversation introuvable' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO support_messages (conversation_id, business_id, sender_id, sender_role, sender_name, content, used_ai_draft)
  VALUES (p_conversation_id, v_biz, auth.uid(), 'founder', 'Support Patron', p_content, p_used_ai_draft)
  RETURNING * INTO v_msg;

  UPDATE support_conversations
  SET last_message_at = v_msg.created_at,
      last_message_preview = left(p_content, 120),
      updated_at = now()
  WHERE id = p_conversation_id;

  RETURN v_msg;
END;
$$;

CREATE OR REPLACE FUNCTION close_support_conversation(p_conversation_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_founder() THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  UPDATE support_conversations SET status = 'closed', updated_at = now()
  WHERE id = p_conversation_id;

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION mark_support_read(p_conversation_id uuid, p_as_founder boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_biz uuid;
BEGIN
  SELECT business_id INTO v_biz FROM support_conversations WHERE id = p_conversation_id;
  IF v_biz IS NULL THEN
    RAISE EXCEPTION 'Conversation introuvable' USING ERRCODE = 'P0001';
  END IF;

  IF p_as_founder THEN
    IF NOT is_founder() THEN
      RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
    END IF;
    UPDATE support_conversations SET founder_last_read_at = now() WHERE id = p_conversation_id;
  ELSE
    IF NOT is_member(v_biz) THEN
      RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
    END IF;
    UPDATE support_conversations SET business_last_read_at = now() WHERE id = p_conversation_id;
  END IF;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION open_or_get_support_conversation(uuid)         TO authenticated;
GRANT EXECUTE ON FUNCTION send_support_message(uuid, text)               TO authenticated;
GRANT EXECUTE ON FUNCTION send_founder_support_reply(uuid, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION close_support_conversation(uuid)               TO authenticated;
GRANT EXECUTE ON FUNCTION mark_support_read(uuid, boolean)               TO authenticated;

-- ─── Realtime ────────────────────────────────────────────────
-- REPLICA IDENTITY FULL so UPDATE payloads (e.g. status flipping back to
-- 'open', last_message_at bumping) carry full row data — same fix as
-- migration_v35 for chat_room_reads.

ALTER TABLE support_conversations REPLICA IDENTITY FULL;
ALTER TABLE support_messages      REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'support_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE support_messages;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'support_conversations'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE support_conversations;
  END IF;
END $$;
