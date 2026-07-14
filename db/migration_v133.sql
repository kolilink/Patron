-- ============================================================
-- Patron — Migration v133
-- Run in Supabase SQL Editor AFTER migration_v132
--
-- Mystic: in-app AI business advisor. Merchants ask questions about their
-- own sales/stock/cash and get advice grounded in real numbers (via the
-- existing get_reports_snapshot/get_stock_velocity RPCs, called by the
-- mystic-chat edge function with the caller's own JWT — never service-role,
-- since those RPCs derive role/user_id from auth.uid() internally).
--
-- One conversation per (business, user), not per business — an
-- administrateur's full P&L answer and a vendeur's personal-only answer
-- must never land in the same shared thread the way the boutique chat room
-- intentionally does (see CLAUDE.md).
--
-- Quota model: one rolling-24-hour-window mechanism serves both the free
-- and paid tier (3/24h vs 100/24h) — not two separate systems — so there is
-- no true "unlimited": even the paid tier has a hard, known ceiling, so a
-- bug or a compromised account can never cost more than that ceiling
-- allows. The first 10 user messages ever in a conversation bypass the
-- window entirely (the "welcome burst") so a brand-new merchant's first
-- real session never hits friction.
--
-- All enforcement lives in send_mystic_message() (SECURITY DEFINER) — never
-- client-side, which would be trivially bypassed. get_mystic_quota_status()
-- is a read-only companion so the client can render a live countdown and
-- decide when to show the upsell before a send is even attempted.
-- ============================================================

-- ─── Tables ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mystic_conversations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  last_message_at  timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS mystic_conversations_one_per_user_business
  ON mystic_conversations(business_id, user_id);

CREATE TABLE IF NOT EXISTS mystic_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES mystic_conversations(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user', 'assistant')),
  content         text NOT NULL CHECK (length(trim(content)) > 0),
  status          text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'failed')),
  error_note      text,
  model           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mystic_messages_conv_created
  ON mystic_messages(conversation_id, created_at);

-- One rolling-window tracker per user, shared by both tiers — the limit (3
-- vs 100) is looked up from has_ai_access() at check time, not stored here.
CREATE TABLE IF NOT EXISTS mystic_quota (
  user_id         uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  window_start    timestamptz NOT NULL DEFAULT now(),
  count_in_window int NOT NULL DEFAULT 0
);

-- ─── RLS ─────────────────────────────────────────────────────
-- No client INSERT/UPDATE policy anywhere — every write goes through the
-- SECURITY DEFINER RPCs below, same posture as support_conversations/
-- support_messages/support_ai_drafts (migration_v126). mystic_quota has no
-- client-facing policy at all (not even SELECT) — its state is only ever
-- exposed through get_mystic_quota_status(), never queried directly.

ALTER TABLE mystic_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE mystic_messages      ENABLE ROW LEVEL SECURITY;
ALTER TABLE mystic_quota         ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Voir sa propre conversation Mystic" ON mystic_conversations;
DROP POLICY IF EXISTS "Voir ses propres messages Mystic"   ON mystic_messages;

CREATE POLICY "Voir sa propre conversation Mystic"
  ON mystic_conversations FOR SELECT
  USING (user_id = auth.uid() AND is_member(business_id));

CREATE POLICY "Voir ses propres messages Mystic"
  ON mystic_messages FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM mystic_conversations c
    WHERE c.id = mystic_messages.conversation_id AND c.user_id = auth.uid()
  ));

-- ─── has_ai_access() ─────────────────────────────────────────
-- Mirrors app/(app)/_layout.tsx's isSubscriptionExpired()/hasBonusAccess()
-- logic server-side, inverted (true = has access): active subscription, OR
-- a still-live referral bonus (bonus_access_until, migration_v130 — stacks
-- independently of subscription_status/trial_ends_at, see CLAUDE.md), OR
-- still within trial.

CREATE OR REPLACE FUNCTION has_ai_access(p_business_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT
      b.subscription_status = 'active'
      OR (b.bonus_access_until IS NOT NULL AND b.bonus_access_until > now())
      OR (b.subscription_status = 'trialing' AND b.trial_ends_at IS NOT NULL AND b.trial_ends_at > now())
    FROM businesses b
    WHERE b.id = p_business_id
  ), false);
$$;

GRANT EXECUTE ON FUNCTION has_ai_access(uuid) TO authenticated;

-- ─── RPCs ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION open_or_get_mystic_conversation(p_business_id uuid)
RETURNS mystic_conversations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv mystic_conversations;
BEGIN
  IF NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_conv FROM mystic_conversations
  WHERE business_id = p_business_id AND user_id = auth.uid();

  IF NOT FOUND THEN
    INSERT INTO mystic_conversations (business_id, user_id)
    VALUES (p_business_id, auth.uid())
    RETURNING * INTO v_conv;
  END IF;

  RETURN v_conv;
END;
$$;

-- Records the user's message and atomically enforces the quota in the same
-- statement — the real enforcement point, never the client. A rejected call
-- rolls back any quota mutation from this same call (Postgres functions are
-- atomic per top-level call), so a denied message never consumes a slot.
CREATE OR REPLACE FUNCTION send_mystic_message(p_business_id uuid, p_content text)
RETURNS mystic_messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv        mystic_conversations;
  v_msg         mystic_messages;
  v_prior_count int;
  v_has_access  boolean;
  v_limit       int;
  v_quota       mystic_quota;
BEGIN
  IF NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;
  IF length(trim(p_content)) = 0 THEN
    RAISE EXCEPTION 'Message vide' USING ERRCODE = 'P0001';
  END IF;

  v_conv := open_or_get_mystic_conversation(p_business_id);

  SELECT count(*) INTO v_prior_count
  FROM mystic_messages
  WHERE conversation_id = v_conv.id AND role = 'user';

  -- Welcome burst: first 10 user messages ever in this conversation bypass
  -- the quota entirely, regardless of tier.
  IF v_prior_count < 10 THEN
    NULL; -- no quota check, no quota mutation
  ELSE
    v_has_access := has_ai_access(p_business_id);
    v_limit := CASE WHEN v_has_access THEN 100 ELSE 3 END;

    SELECT * INTO v_quota FROM mystic_quota WHERE user_id = auth.uid() FOR UPDATE;

    IF NOT FOUND THEN
      INSERT INTO mystic_quota (user_id, window_start, count_in_window)
      VALUES (auth.uid(), now(), 1);
    ELSIF now() - v_quota.window_start >= interval '24 hours' THEN
      UPDATE mystic_quota SET window_start = now(), count_in_window = 1
      WHERE user_id = auth.uid();
    ELSIF v_quota.count_in_window < v_limit THEN
      UPDATE mystic_quota SET count_in_window = count_in_window + 1
      WHERE user_id = auth.uid();
    ELSE
      RAISE EXCEPTION 'Limite de questions atteinte pour l''instant. Réessayez plus tard ou passez à Mystic Illimité.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO mystic_messages (conversation_id, role, content)
  VALUES (v_conv.id, 'user', p_content)
  RETURNING * INTO v_msg;

  UPDATE mystic_conversations
  SET last_message_at = v_msg.created_at, updated_at = now()
  WHERE id = v_conv.id;

  RETURN v_msg;
END;
$$;

-- Read-only quota/entitlement status for the client UI (live countdown,
-- deciding when to show the upsell card) — never used for enforcement
-- itself, that's send_mystic_message's job.
CREATE OR REPLACE FUNCTION get_mystic_quota_status(p_business_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_has_access  boolean;
  v_limit       int;
  v_quota       mystic_quota;
  v_prior_count int;
  v_in_burst    boolean;
  v_remaining   int;
  v_next_reset  timestamptz;
BEGIN
  IF NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  v_has_access := has_ai_access(p_business_id);
  v_limit := CASE WHEN v_has_access THEN 100 ELSE 3 END;

  SELECT count(*) INTO v_prior_count
  FROM mystic_messages mm
  JOIN mystic_conversations mc ON mc.id = mm.conversation_id
  WHERE mc.business_id = p_business_id AND mc.user_id = auth.uid() AND mm.role = 'user';
  v_in_burst := v_prior_count < 10;

  SELECT * INTO v_quota FROM mystic_quota WHERE user_id = auth.uid();

  IF NOT FOUND OR now() - v_quota.window_start >= interval '24 hours' THEN
    v_remaining  := v_limit;
    v_next_reset := NULL;
  ELSE
    v_remaining  := GREATEST(0, v_limit - v_quota.count_in_window);
    v_next_reset := CASE WHEN v_remaining = 0 THEN v_quota.window_start + interval '24 hours' ELSE NULL END;
  END IF;

  RETURN jsonb_build_object(
    'has_ai_access',           v_has_access,
    'limit',                   v_limit,
    'remaining',               v_remaining,
    'next_reset_at',           v_next_reset,
    'in_welcome_burst',        v_in_burst,
    'burst_messages_remaining', GREATEST(0, 10 - v_prior_count)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION open_or_get_mystic_conversation(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION send_mystic_message(uuid, text)       TO authenticated;
GRANT EXECUTE ON FUNCTION get_mystic_quota_status(uuid)         TO authenticated;
