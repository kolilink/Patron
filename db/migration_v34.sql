-- ============================================================
-- Patron — Migration v34
-- Run in Supabase SQL Editor AFTER migration_v33
-- Adds read-receipt tracking for chat rooms ("Vu").
-- ============================================================

CREATE TABLE IF NOT EXISTS chat_room_reads (
  user_id      uuid        NOT NULL REFERENCES profiles(id)    ON DELETE CASCADE,
  room_id      uuid        NOT NULL REFERENCES chat_rooms(id)  ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, room_id)
);

ALTER TABLE chat_room_reads ENABLE ROW LEVEL SECURITY;

-- Users manage their own read cursor
CREATE POLICY "Gérer sa propre lecture"
  ON chat_room_reads FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Users can see others' cursors in rooms they can access
CREATE POLICY "Voir lecture dans ses salles"
  ON chat_room_reads FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM chat_rooms cr
      WHERE cr.id = room_id
        AND (cr.is_global = true OR (cr.business_id IS NOT NULL AND is_member(cr.business_id)))
    )
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'chat_room_reads'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE chat_room_reads;
  END IF;
END $$;
