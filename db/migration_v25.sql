-- migration_v25: Founder analytics event tracking
-- Every sale, offline queue, and debt payment lands here.
-- Nick reads via Supabase service role (bypasses RLS). Merchants insert only.

CREATE TABLE analytics_events (
  id          BIGSERIAL PRIMARY KEY,
  business_id UUID REFERENCES businesses(id) ON DELETE SET NULL,
  user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  event       TEXT NOT NULL,
  metadata    JSONB,
  created_at  TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE analytics_events ENABLE ROW LEVEL SECURITY;

-- Merchants can insert their own events only — they never read this table
CREATE POLICY "insert own events"
  ON analytics_events FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());
