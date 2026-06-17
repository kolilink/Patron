-- ============================================================
-- Patron — Migration v55
-- Run in Supabase SQL Editor AFTER migration_v54
--
-- Adds reply threading to chat_messages.
-- reply_to_content and reply_to_sender_name are denormalised so
-- the app never needs a JOIN to render a reply preview.
-- ============================================================

ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS reply_to_id           uuid REFERENCES chat_messages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reply_to_content      text,
  ADD COLUMN IF NOT EXISTS reply_to_sender_name  text;
