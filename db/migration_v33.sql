-- ============================================================
-- Patron — Migration v33
-- Run in Supabase SQL Editor AFTER migration_v32
-- Adds dual-mode chat: private boutique rooms + global Le Marché
-- Safe to re-run if tables already exist.
-- ============================================================

-- ─── Tables ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS chat_rooms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  business_id uuid REFERENCES businesses(id) ON DELETE CASCADE,
  is_global   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id     uuid NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  sender_id   uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  sender_name text NOT NULL,
  content     text NOT NULL CHECK (length(trim(content)) > 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_messages_room_created
  ON chat_messages(room_id, created_at);

-- ─── RLS ─────────────────────────────────────────────────────

ALTER TABLE chat_rooms    ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Lire salles accessibles"    ON chat_rooms;
DROP POLICY IF EXISTS "Lire messages de ses salles" ON chat_messages;
DROP POLICY IF EXISTS "Envoyer dans ses salles"     ON chat_messages;

CREATE POLICY "Lire salles accessibles"
  ON chat_rooms FOR SELECT
  USING (
    is_global = true
    OR (business_id IS NOT NULL AND is_member(business_id))
  );

CREATE POLICY "Lire messages de ses salles"
  ON chat_messages FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM chat_rooms cr
      WHERE cr.id = room_id
        AND (
          cr.is_global = true
          OR (cr.business_id IS NOT NULL AND is_member(cr.business_id))
        )
    )
  );

CREATE POLICY "Envoyer dans ses salles"
  ON chat_messages FOR INSERT
  WITH CHECK (
    sender_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM chat_rooms cr
      WHERE cr.id = room_id
        AND (
          cr.is_global = true
          OR (cr.business_id IS NOT NULL AND is_member(cr.business_id))
        )
    )
  );

-- ─── Realtime ────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'chat_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE chat_messages;
  END IF;
END $$;

-- ─── Global room seed ────────────────────────────────────────

INSERT INTO chat_rooms (id, name, is_global)
VALUES ('00000000-0000-0000-0000-000000000001', 'Le Marché', true)
ON CONFLICT DO NOTHING;

-- ─── Boutique room trigger ────────────────────────────────────

CREATE OR REPLACE FUNCTION create_boutique_room()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO chat_rooms (name, business_id, is_global)
  VALUES ('Ma Boutique', NEW.id, false);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_business_created_chat_room ON businesses;
CREATE TRIGGER on_business_created_chat_room
  AFTER INSERT ON businesses
  FOR EACH ROW EXECUTE FUNCTION create_boutique_room();

-- Backfill boutique rooms for existing businesses that don't have one yet
INSERT INTO chat_rooms (name, business_id, is_global)
SELECT 'Ma Boutique', b.id, false
FROM businesses b
WHERE NOT EXISTS (
  SELECT 1 FROM chat_rooms cr WHERE cr.business_id = b.id
);
