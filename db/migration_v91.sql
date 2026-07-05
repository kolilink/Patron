-- v91: relax chat_messages content constraint for voice messages
--
-- v33 created: CHECK (length(trim(content)) > 0)
-- Postgres auto-names inline constraints as {table}_{column}_check.
-- Voice messages legitimately have empty content, so we broaden the gate.

ALTER TABLE chat_messages
  DROP CONSTRAINT IF EXISTS chat_messages_content_check;

ALTER TABLE chat_messages
  ADD CONSTRAINT chat_messages_content_check
  CHECK (message_type = 'voice' OR length(trim(content)) > 0);
