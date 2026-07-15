-- ============================================================
-- Patron — Migration v147
-- Run in Supabase SQL Editor AFTER migration_v146
--
-- Makes Alpha's daily message limits (free and paid tier) live-
-- configurable via a small config table + one RPC, instead of
-- requiring a new migration every time either number changes (as
-- migration_v135.sql, v136.sql, and v146.sql all did). Sebastiao
-- wants to be able to raise or lower either tier on demand — a
-- generosity gesture, a promotion, testing, or reverting a change —
-- without writing a full migration by hand each time.
--
-- Takes effect immediately: v_limit is read fresh from app_config on
-- every send_alpha_message/get_alpha_quota_status call, nothing is
-- cached. A user already mid-window sees their new remaining count
-- the moment they check — but the change applies to how much they
-- GET, not retroactively to what they've already used this window
-- (someone already at their old cap doesn't get a mid-window top-up
-- just because the limit went up; they see the new, higher number
-- once their 24h window naturally resets).
-- ============================================================

CREATE TABLE IF NOT EXISTS app_config (
  key        TEXT PRIMARY KEY,
  value      INT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seeded with the values shipped in migration_v146.sql. Reverting to
-- these later is exactly what set_alpha_daily_limit is for below, not
-- another migration.
INSERT INTO app_config (key, value) VALUES
  ('alpha_free_daily_limit', 5),
  ('alpha_paid_daily_limit', 100)
ON CONFLICT (key) DO NOTHING;

-- service_role only, no client RLS policy — same posture as every
-- other internal-only config table in this project (djomi_pending_
-- payments, alpha_whatsapp_reminders_sent, etc.).
ALTER TABLE app_config ENABLE ROW LEVEL SECURITY;

-- set_alpha_daily_limit('free' | 'paid', new_limit) — the one function
-- to change either tier's daily cap. To revert to today's shipped
-- values:
--   SELECT set_alpha_daily_limit('free', 5);
--   SELECT set_alpha_daily_limit('paid', 100);
-- To check current values at any time: SELECT * FROM app_config;
CREATE OR REPLACE FUNCTION set_alpha_daily_limit(p_tier TEXT, p_limit INT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_tier NOT IN ('free', 'paid') THEN
    RAISE EXCEPTION 'p_tier must be ''free'' or ''paid''';
  END IF;
  IF p_limit < 1 THEN
    RAISE EXCEPTION 'p_limit must be a positive number';
  END IF;

  UPDATE app_config
  SET value = p_limit, updated_at = now()
  WHERE key = 'alpha_' || p_tier || '_daily_limit';
END;
$$;

REVOKE EXECUTE ON FUNCTION set_alpha_daily_limit(TEXT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION set_alpha_daily_limit(TEXT, INT) TO service_role;

-- send_alpha_message / get_alpha_quota_status now read v_limit from
-- app_config instead of a hardcoded CASE literal — everything else in
-- both functions is unchanged from migration_v146.sql.
CREATE OR REPLACE FUNCTION send_alpha_message(p_business_id uuid, p_content text)
RETURNS alpha_messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv        alpha_conversations;
  v_msg         alpha_messages;
  v_prior_count int;
  v_has_access  boolean;
  v_limit       int;
  v_quota       alpha_quota;
BEGIN
  IF NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;
  IF length(trim(p_content)) = 0 THEN
    RAISE EXCEPTION 'Message vide' USING ERRCODE = 'P0001';
  END IF;

  v_conv := open_or_get_alpha_conversation(p_business_id);

  SELECT count(*) INTO v_prior_count
  FROM alpha_messages
  WHERE conversation_id = v_conv.id AND role = 'user';

  -- Welcome burst: first 10 user messages ever in this conversation bypass
  -- the quota entirely, regardless of tier.
  IF v_prior_count < 10 THEN
    NULL; -- no quota check, no quota mutation
  ELSE
    v_has_access := has_ai_access(p_business_id);
    SELECT value INTO v_limit FROM app_config
    WHERE key = CASE WHEN v_has_access THEN 'alpha_paid_daily_limit' ELSE 'alpha_free_daily_limit' END;

    SELECT * INTO v_quota FROM alpha_quota WHERE user_id = auth.uid() FOR UPDATE;

    IF NOT FOUND THEN
      INSERT INTO alpha_quota (user_id, window_start, count_in_window)
      VALUES (auth.uid(), now(), 1);
    ELSIF now() - v_quota.window_start >= interval '24 hours' THEN
      UPDATE alpha_quota SET window_start = now(), count_in_window = 1
      WHERE user_id = auth.uid();
    ELSIF v_quota.count_in_window < v_limit THEN
      UPDATE alpha_quota SET count_in_window = count_in_window + 1
      WHERE user_id = auth.uid();
    ELSE
      RAISE EXCEPTION 'Limite de questions atteinte pour l''instant. Réessayez plus tard ou passez à Alpha Illimité.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO alpha_messages (conversation_id, role, content)
  VALUES (v_conv.id, 'user', p_content)
  RETURNING * INTO v_msg;

  UPDATE alpha_conversations
  SET last_message_at = v_msg.created_at, updated_at = now()
  WHERE id = v_conv.id;

  RETURN v_msg;
END;
$$;

CREATE OR REPLACE FUNCTION get_alpha_quota_status(p_business_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_has_access  boolean;
  v_limit       int;
  v_quota       alpha_quota;
  v_prior_count int;
  v_in_burst    boolean;
  v_remaining   int;
  v_next_reset  timestamptz;
BEGIN
  IF NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  v_has_access := has_ai_access(p_business_id);
  SELECT value INTO v_limit FROM app_config
  WHERE key = CASE WHEN v_has_access THEN 'alpha_paid_daily_limit' ELSE 'alpha_free_daily_limit' END;

  SELECT count(*) INTO v_prior_count
  FROM alpha_messages am
  JOIN alpha_conversations ac ON ac.id = am.conversation_id
  WHERE ac.business_id = p_business_id AND ac.user_id = auth.uid() AND am.role = 'user';
  v_in_burst := v_prior_count < 10;

  SELECT * INTO v_quota FROM alpha_quota WHERE user_id = auth.uid();

  IF NOT FOUND OR now() - v_quota.window_start >= interval '24 hours' THEN
    v_remaining  := v_limit;
    v_next_reset := NULL;
  ELSE
    v_remaining  := GREATEST(0, v_limit - v_quota.count_in_window);
    v_next_reset := CASE WHEN v_remaining = 0 THEN v_quota.window_start + interval '24 hours' ELSE NULL END;
  END IF;

  RETURN jsonb_build_object(
    'has_ai_access',            v_has_access,
    'limit',                    v_limit,
    'remaining',                v_remaining,
    'next_reset_at',            v_next_reset,
    'in_welcome_burst',         v_in_burst,
    'burst_messages_remaining', GREATEST(0, 10 - v_prior_count)
  );
END;
$$;
