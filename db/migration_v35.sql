-- ============================================================
-- Patron — Migration v35
-- Run in Supabase SQL Editor AFTER migration_v34
-- Fixes realtime read receipts: without REPLICA IDENTITY FULL,
-- UPDATE events on chat_room_reads arrive with an empty payload,
-- so the client can't see the new last_read_at value.
-- ============================================================

ALTER TABLE chat_room_reads REPLICA IDENTITY FULL;
