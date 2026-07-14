-- v132: image messages in boutique chat (incl. partner DM rooms, which share
-- chat_messages via room_id) and support chat.
-- Le Marché is deliberately excluded — public forum, different moderation
-- exposure than the two known-party surfaces below.

-- ─── 1. chat_messages: extend the v90 voice-message pattern ──────────────

-- Drop the v91 constraint before widening message_type's CHECK (Postgres
-- won't let you alter a column's CHECK in place — old constraint must go
-- first, otherwise ADD COLUMN below's CHECK conflicts with the existing one).
ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_message_type_check;
ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_content_check;

ALTER TABLE chat_messages
  ALTER COLUMN message_type SET DEFAULT 'text',
  ADD CONSTRAINT chat_messages_message_type_check
    CHECK (message_type IN ('text', 'voice', 'image')),
  ADD COLUMN IF NOT EXISTS image_url    TEXT,
  ADD COLUMN IF NOT EXISTS image_width  INT,
  ADD COLUMN IF NOT EXISTS image_height INT,
  ADD CONSTRAINT chat_messages_content_check
    CHECK (message_type IN ('voice', 'image') OR length(trim(content)) > 0);

-- ─── 2. support_messages: same message_type/image columns, fresh addition ──

ALTER TABLE support_messages DROP CONSTRAINT IF EXISTS support_messages_content_check;

ALTER TABLE support_messages
  ADD COLUMN IF NOT EXISTS message_type TEXT NOT NULL DEFAULT 'text'
                                         CHECK (message_type IN ('text', 'image')),
  ADD COLUMN IF NOT EXISTS image_url    TEXT,
  ADD COLUMN IF NOT EXISTS image_width  INT,
  ADD COLUMN IF NOT EXISTS image_height INT,
  ADD CONSTRAINT support_messages_content_check
    CHECK (message_type = 'image' OR length(trim(content)) > 0);

-- ─── 3. Shared storage bucket for all image messages ──────────────────────
-- Path convention: {context}/{room_or_conversation_id}/{message_id}.jpg
-- Public bucket, non-guessable UUID path, access gated at the message row
-- level by chat_messages/support_messages RLS — same posture as
-- voice-messages (see migration_v90.sql/v92.sql).

INSERT INTO storage.buckets (id, name, public)
VALUES ('message-images', 'message-images', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "message images upload"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'message-images' AND auth.uid() IS NOT NULL);

CREATE POLICY "message images read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'message-images' AND auth.uid() IS NOT NULL);

CREATE POLICY "message images delete"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'message-images' AND auth.uid() IS NOT NULL);

-- ─── 4. support_messages RPCs: accept an optional image ───────────────────
-- Both RPCs currently RAISE 'Message vide' whenever trimmed content is
-- empty. An image-only message (no caption) must be allowed to pass that
-- check, same relaxation as the chat_messages_content_check above.

-- Rebased onto the v127 body (not v126's original) — v127 rescoped this
-- function to per-sender conversations (merchant_user_id) and added a
-- merchant_name refresh-on-send that v126's body didn't have. Only the
-- image_url/image_width/image_height + message_type additions are new here.
--
-- CREATE OR REPLACE does NOT edit a function in place when the argument
-- *count* changes, even with the new params all DEFAULT-ed — Postgres treats
-- it as a distinct overload and keeps the old signature alongside the new
-- one. That leaves two versions of send_support_message resolvable by
-- PostgREST's named-argument RPC calls, which is ambiguous for any call
-- that only supplies the original two params (exactly what the existing
-- text-only send path does) — so the old signature must be dropped
-- explicitly, not just superseded.
DROP FUNCTION IF EXISTS send_support_message(uuid, text);

CREATE OR REPLACE FUNCTION send_support_message(
  p_business_id  uuid,
  p_content      text,
  p_image_url    text DEFAULT NULL,
  p_image_width  int  DEFAULT NULL,
  p_image_height int  DEFAULT NULL
)
RETURNS support_messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv support_conversations;
  v_msg  support_messages;
  v_name text;
  v_type text := CASE WHEN p_image_url IS NOT NULL THEN 'image' ELSE 'text' END;
BEGIN
  IF NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;
  IF v_type = 'text' AND length(trim(p_content)) = 0 THEN
    RAISE EXCEPTION 'Message vide' USING ERRCODE = 'P0001';
  END IF;

  v_conv := open_or_get_support_conversation(p_business_id);

  SELECT name INTO v_name FROM profiles WHERE id = auth.uid();

  IF v_conv.status = 'closed' THEN
    UPDATE support_conversations SET status = 'open' WHERE id = v_conv.id;
  END IF;

  INSERT INTO support_messages
    (conversation_id, business_id, sender_id, sender_role, sender_name, content,
     message_type, image_url, image_width, image_height)
  VALUES
    (v_conv.id, p_business_id, auth.uid(), 'merchant', COALESCE(v_name, 'Membre'), p_content,
     v_type, p_image_url, p_image_width, p_image_height)
  RETURNING * INTO v_msg;

  UPDATE support_conversations
  SET last_message_at = v_msg.created_at,
      last_message_preview = CASE WHEN v_type = 'image' THEN '📷 Photo' ELSE left(p_content, 120) END,
      merchant_name = COALESCE(v_name, merchant_name),
      updated_at = now()
  WHERE id = v_conv.id;

  RETURN v_msg;
END;
$$;

-- Same overload-vs-replace issue as send_support_message above.
DROP FUNCTION IF EXISTS send_founder_support_reply(uuid, text, boolean);

CREATE OR REPLACE FUNCTION send_founder_support_reply(
  p_conversation_id uuid,
  p_content         text,
  p_used_ai_draft   boolean DEFAULT false,
  p_image_url       text    DEFAULT NULL,
  p_image_width     int     DEFAULT NULL,
  p_image_height    int     DEFAULT NULL
)
RETURNS support_messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_biz  uuid;
  v_msg  support_messages;
  v_type text := CASE WHEN p_image_url IS NOT NULL THEN 'image' ELSE 'text' END;
BEGIN
  IF NOT is_founder() THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;
  IF v_type = 'text' AND length(trim(p_content)) = 0 THEN
    RAISE EXCEPTION 'Message vide' USING ERRCODE = 'P0001';
  END IF;

  SELECT business_id INTO v_biz FROM support_conversations WHERE id = p_conversation_id;
  IF v_biz IS NULL THEN
    RAISE EXCEPTION 'Conversation introuvable' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO support_messages
    (conversation_id, business_id, sender_id, sender_role, sender_name, content, used_ai_draft,
     message_type, image_url, image_width, image_height)
  VALUES
    (p_conversation_id, v_biz, auth.uid(), 'founder', 'Support Patron', p_content, p_used_ai_draft,
     v_type, p_image_url, p_image_width, p_image_height)
  RETURNING * INTO v_msg;

  UPDATE support_conversations
  SET last_message_at = v_msg.created_at,
      last_message_preview = CASE WHEN v_type = 'image' THEN '📷 Photo' ELSE left(p_content, 120) END,
      updated_at = now()
  WHERE id = p_conversation_id;

  RETURN v_msg;
END;
$$;
