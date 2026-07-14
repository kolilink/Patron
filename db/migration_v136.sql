-- Raises the free tier's daily Alpha quota from 3 to 5 messages/24h, as part
-- of a UX pass making the free-vs-paid quota states clearer in the app
-- (distinct "upgrade" popup vs. simple "come back later" wait state — see
-- CLAUDE.md's Alpha section). 5 gives the free-tier counter ("N messages
-- restantes") more room to feel like a real trial rather than an instant
-- wall, without touching the 10-message welcome burst or the paid tier's
-- 20/24h (migration_v135.sql, still in effect while Groq's Developer tier
-- signup is blocked).

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
    v_limit := CASE WHEN v_has_access THEN 20 ELSE 5 END;

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
  v_limit := CASE WHEN v_has_access THEN 20 ELSE 5 END;

  SELECT count(*) INTO v_prior_count
  FROM alpha_messages mm
  JOIN alpha_conversations mc ON mc.id = mm.conversation_id
  WHERE mc.business_id = p_business_id AND mc.user_id = auth.uid() AND mm.role = 'user';
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
