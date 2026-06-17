-- Migration v56: message & post editing (edited_at tracking)

-- ── chat_messages ─────────────────────────────────────────────────────────────

ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS edited_at timestamptz;

-- Trigger: auto-stamp edited_at whenever content changes
CREATE OR REPLACE FUNCTION update_chat_message_edited_at()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.content IS DISTINCT FROM NEW.content THEN
    NEW.edited_at = NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS chat_messages_set_edited_at ON chat_messages;
CREATE TRIGGER chat_messages_set_edited_at
  BEFORE UPDATE ON chat_messages
  FOR EACH ROW EXECUTE FUNCTION update_chat_message_edited_at();

-- RLS: sender can update only their own messages
CREATE POLICY "Expediteur peut modifier ses messages"
ON chat_messages FOR UPDATE
TO authenticated
USING (sender_id = auth.uid());

-- ── market_posts ──────────────────────────────────────────────────────────────

ALTER TABLE market_posts
  ADD COLUMN IF NOT EXISTS edited_at timestamptz;

-- Trigger: auto-stamp edited_at whenever title or content changes
CREATE OR REPLACE FUNCTION update_market_post_edited_at()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.title IS DISTINCT FROM NEW.title OR OLD.content IS DISTINCT FROM NEW.content THEN
    NEW.edited_at = NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS market_posts_set_edited_at ON market_posts;
CREATE TRIGGER market_posts_set_edited_at
  BEFORE UPDATE ON market_posts
  FOR EACH ROW EXECUTE FUNCTION update_market_post_edited_at();

-- RLS: author can update only their own posts
CREATE POLICY "Auteur peut modifier ses posts"
ON market_posts FOR UPDATE
TO authenticated
USING (author_id = auth.uid());
