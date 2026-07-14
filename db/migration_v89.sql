-- v89: push notification infrastructure
-- device_tokens: one row per user per device (push token can change on reinstall)
CREATE TABLE device_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES auth.users NOT NULL,
  token      TEXT NOT NULL,
  platform   TEXT CHECK (platform IN ('ios', 'android')) NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, token)
);
ALTER TABLE device_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own tokens select" ON device_tokens FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "own tokens insert" ON device_tokens FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "own tokens update" ON device_tokens FOR UPDATE USING (user_id = auth.uid());
CREATE POLICY "own tokens delete" ON device_tokens FOR DELETE USING (user_id = auth.uid());

-- notification_log: audit trail for sent notifications; used for deduplication (low_stock cooldown)
-- No user-facing RLS — service role only via Edge Functions
CREATE TABLE notification_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID REFERENCES businesses NOT NULL,
  event_type      TEXT NOT NULL,
  payload         JSONB NOT NULL DEFAULT '{}',
  sent_at         TIMESTAMPTZ DEFAULT now(),
  recipient_count INT DEFAULT 0
);
