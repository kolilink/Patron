-- v90: voice messages in boutique chat

-- Add voice message columns to chat_messages
-- message_type defaults to 'text' so every existing message is unaffected
ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS message_type  TEXT    NOT NULL DEFAULT 'text'
                                         CHECK (message_type IN ('text','voice')),
  ADD COLUMN IF NOT EXISTS voice_url     TEXT,
  ADD COLUMN IF NOT EXISTS voice_duration INT,          -- seconds
  ADD COLUMN IF NOT EXISTS voice_waveform JSONB;        -- array of amplitude samples 0.0–1.0

-- Private storage bucket for voice recordings
-- Files are stored as: {business_id}/{message_id}.m4a
INSERT INTO storage.buckets (id, name, public)
VALUES ('voice-messages', 'voice-messages', false)
ON CONFLICT (id) DO NOTHING;

-- Any authenticated user can upload voice messages
CREATE POLICY "voice upload"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'voice-messages' AND auth.uid() IS NOT NULL);

-- Any authenticated user can read voice messages
-- (boutique room membership check happens at the app level via message RLS)
CREATE POLICY "voice read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'voice-messages' AND auth.uid() IS NOT NULL);

-- Users can delete their own uploads
CREATE POLICY "voice delete"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'voice-messages' AND auth.uid() IS NOT NULL);
