-- ============================================================
-- Patron — Migration v146
-- Run in Supabase SQL Editor AFTER migration_v145
--
-- Raises the paid-tier Alpha quota from 20/24h back to 100/24h,
-- reversing migration_v135.sql's stopgap. Free tier (5/24h) and the
-- 10-message welcome burst are untouched.
--
-- v135.sql lowered this specifically because Groq's free tier caps the
-- WHOLE PLATFORM at 100,000 tokens/day, shared across every business —
-- a single active paying customer alone could exhaust that entire
-- shared budget and degrade every other business's access for the
-- rest of the day. That risk is now substantially mitigated by the
-- Groq→OpenAI automatic fallback added after v135 shipped
-- (alpha-chat/index.ts's generateReply — the instant Groq fails for
-- any reason, including the daily ceiling, the same request falls
-- through to OpenAI automatically, no manual cutover). Confirmed
-- OPENAI_API_KEY is actually set before this migration was written —
-- without it, the fallback has nothing to fall through to and this
-- change would reintroduce the original starvation risk under a
-- different failure mode.
--
-- Per-message cost even fully on the OpenAI fallback is negligible
-- (~$0.0002–0.0003/reply at gpt-4o-mini pricing, ~900–1,600 tokens/
-- reply) — cost was never the reason for the 20 cap, Groq's shared
-- capacity ceiling was, and that's now a soft-degrade (falls to
-- OpenAI) rather than a hard failure.
-- ============================================================

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
    v_limit := CASE WHEN v_has_access THEN 100 ELSE 5 END;

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
  v_limit := CASE WHEN v_has_access THEN 100 ELSE 5 END;

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
