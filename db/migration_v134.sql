-- ============================================================
-- Patron — Migration v134
-- Run in Supabase SQL Editor AFTER migration_v133
--
-- Renames the AI business advisor from "Mystic" to "Alpha" at the schema
-- level (mystic_* tables/functions -> alpha_*). ALTER TABLE/INDEX RENAME
-- alone is not enough here: plpgsql function bodies resolve table and
-- function names as text at execution time, not by OID, so
-- send_mystic_message's internal call to open_or_get_mystic_conversation()
-- and its `FROM mystic_messages` queries would break the moment the
-- underlying objects were renamed out from under them. The three RPCs are
-- therefore dropped and recreated under their new names, with bodies
-- rewritten to reference the new table/function names throughout —
-- identical logic to migration_v133.sql otherwise. has_ai_access() is
-- untouched (its name was never Mystic-specific).
-- ============================================================

-- ─── Rename tables + indexes ─────────────────────────────────

ALTER TABLE mystic_conversations RENAME TO alpha_conversations;
ALTER TABLE mystic_messages      RENAME TO alpha_messages;
ALTER TABLE mystic_quota         RENAME TO alpha_quota;

ALTER INDEX mystic_conversations_one_per_user_business RENAME TO alpha_conversations_one_per_user_business;
ALTER INDEX mystic_messages_conv_created               RENAME TO alpha_messages_conv_created;

-- ─── Re-point RLS policies (table rename carries the policies over by oid,
-- but the labels still said "Mystic") ─────────────────────────────────────

DROP POLICY IF EXISTS "Voir sa propre conversation Mystic" ON alpha_conversations;
DROP POLICY IF EXISTS "Voir ses propres messages Mystic"   ON alpha_messages;

CREATE POLICY "Voir sa propre conversation Alpha"
  ON alpha_conversations FOR SELECT
  USING (user_id = auth.uid() AND is_member(business_id));

CREATE POLICY "Voir ses propres messages Alpha"
  ON alpha_messages FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM alpha_conversations c
    WHERE c.id = alpha_messages.conversation_id AND c.user_id = auth.uid()
  ));

-- ─── Drop + recreate the three RPCs under their new names ────────────────

DROP FUNCTION IF EXISTS open_or_get_mystic_conversation(uuid);
DROP FUNCTION IF EXISTS send_mystic_message(uuid, text);
DROP FUNCTION IF EXISTS get_mystic_quota_status(uuid);

CREATE OR REPLACE FUNCTION open_or_get_alpha_conversation(p_business_id uuid)
RETURNS alpha_conversations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv alpha_conversations;
BEGIN
  IF NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_conv FROM alpha_conversations
  WHERE business_id = p_business_id AND user_id = auth.uid();

  IF NOT FOUND THEN
    INSERT INTO alpha_conversations (business_id, user_id)
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
    v_limit := CASE WHEN v_has_access THEN 100 ELSE 3 END;

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

-- Read-only quota/entitlement status for the client UI (live countdown,
-- deciding when to show the upsell card) — never used for enforcement
-- itself, that's send_alpha_message's job.
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
  v_limit := CASE WHEN v_has_access THEN 100 ELSE 3 END;

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

GRANT EXECUTE ON FUNCTION open_or_get_alpha_conversation(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION send_alpha_message(uuid, text)       TO authenticated;
GRANT EXECUTE ON FUNCTION get_alpha_quota_status(uuid)         TO authenticated;
