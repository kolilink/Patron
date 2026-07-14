-- ============================================================
-- Patron — Migration v145
-- Run in Supabase SQL Editor AFTER migration_v144
--
-- The in-app WhatsApp-reminder consent prompt — closes a real gap in
-- how migration_v143.sql originally shipped: get_and_mark_alpha_
-- whatsapp_candidates() had no consent check at all, which is a real
-- compliance problem for a Marketing-category WhatsApp template (see
-- CLAUDE.md's "Alpha WhatsApp reminder" entry).
--
-- Deliberately NOT asked at the first free-tier block. Asking that
-- early is a premature, disconnected promise — the actual reminder
-- only fires once someone has hit the free cap on 3 separate days in
-- a week, which might be days away or might never happen. Asking
-- "can we remind you if you ever want to continue" to someone who's
-- barely started reads as a hollow, speculative ask, and if the
-- reminder does eventually fire days or weeks later, the person may
-- not even remember agreeing to it.
--
-- Instead, alpha_whatsapp_reminder_eligible_now() is a read-only
-- mirror of the same qualifying condition get_and_mark_alpha_whatsapp_
-- candidates() uses, callable by the client in real time. The app
-- only shows the consent prompt when this returns true — meaning by
-- the time someone sees "can we remind you," they've ALREADY done the
-- thing that makes the reminder relevant. The promise is grounded in
-- something that just happened, not a guess about the future.
-- ============================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS alpha_whatsapp_consent TEXT
    CONSTRAINT profiles_alpha_whatsapp_consent_check
    CHECK (alpha_whatsapp_consent IS NULL OR alpha_whatsapp_consent IN ('accepted', 'declined'));

-- alpha_whatsapp_reminder_eligible_now: read-only, authenticated-callable.
-- Scoped to the CALLER (auth.uid()) as administrateur of p_business_id —
-- mirrors get_and_mark_alpha_whatsapp_candidates' qualifying condition
-- (hit the free cap on 3+ separate days in the last 7, no current
-- access) but for a single caller/business, no side effects (no
-- marking, no sending). Returns false once consent has already been
-- recorded either way — never asks twice.
CREATE OR REPLACE FUNCTION alpha_whatsapp_reminder_eligible_now(p_business_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_is_admin    boolean;
  v_consent     text;
  v_capped_days int;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM memberships
    WHERE business_id = p_business_id AND user_id = auth.uid() AND role = 'administrateur'
  ) INTO v_is_admin;

  IF NOT v_is_admin THEN
    RETURN false;
  END IF;

  SELECT alpha_whatsapp_consent INTO v_consent FROM profiles WHERE id = auth.uid();
  IF v_consent IS NOT NULL THEN
    RETURN false; -- already asked (accepted or declined) — never ask twice
  END IF;

  IF has_ai_access(p_business_id) THEN
    RETURN false;
  END IF;

  SELECT count(*) INTO v_capped_days
  FROM (
    SELECT (am.created_at AT TIME ZONE 'UTC')::date AS day
    FROM alpha_messages am
    JOIN alpha_conversations ac ON ac.id = am.conversation_id
    WHERE ac.business_id = p_business_id
      AND ac.user_id = auth.uid()
      AND am.role = 'user'
      AND am.created_at >= now() - interval '7 days'
    GROUP BY (am.created_at AT TIME ZONE 'UTC')::date
    HAVING count(*) >= 5
  ) d;

  RETURN v_capped_days >= 3;
END;
$$;

GRANT EXECUTE ON FUNCTION alpha_whatsapp_reminder_eligible_now(uuid) TO authenticated;

-- record_alpha_whatsapp_consent: the only write path for
-- profiles.alpha_whatsapp_consent. Independently re-checks the caller
-- is genuinely an administrateur of p_business_id — doesn't assume
-- alpha_whatsapp_reminder_eligible_now was called first.
CREATE OR REPLACE FUNCTION record_alpha_whatsapp_consent(p_business_id uuid, p_accepted boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM memberships
    WHERE business_id = p_business_id AND user_id = auth.uid() AND role = 'administrateur'
  ) THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  UPDATE profiles
  SET alpha_whatsapp_consent = CASE WHEN p_accepted THEN 'accepted' ELSE 'declined' END
  WHERE id = auth.uid();
END;
$$;

GRANT EXECUTE ON FUNCTION record_alpha_whatsapp_consent(uuid, boolean) TO authenticated;

-- Closes the compliance gap: get_and_mark_alpha_whatsapp_candidates
-- (migration_v143.sql) now only picks up administrateurs who explicitly
-- accepted via record_alpha_whatsapp_consent above. CREATE OR REPLACE
-- with the same signature — no DROP FUNCTION needed, the argument list
-- is unchanged from migration_v143.sql.
CREATE OR REPLACE FUNCTION get_and_mark_alpha_whatsapp_candidates()
RETURNS TABLE(business_id uuid, admin_phone text, checkout_token text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH admins AS (
    SELECT m.business_id, m.user_id, p.phone
    FROM memberships m
    JOIN profiles p ON p.id = m.user_id
    WHERE m.role = 'administrateur'
      AND p.phone IS NOT NULL
      AND p.alpha_whatsapp_consent = 'accepted'
  ),
  capped_days AS (
    SELECT ac.business_id, ac.user_id,
           (am.created_at AT TIME ZONE 'UTC')::date AS day
    FROM alpha_messages am
    JOIN alpha_conversations ac ON ac.id = am.conversation_id
    WHERE am.role = 'user'
      AND am.created_at >= now() - interval '7 days'
    GROUP BY ac.business_id, ac.user_id, (am.created_at AT TIME ZONE 'UTC')::date
    HAVING count(*) >= 5
  ),
  qualifying AS (
    SELECT a.business_id, a.phone
    FROM admins a
    JOIN capped_days cd ON cd.business_id = a.business_id AND cd.user_id = a.user_id
    WHERE NOT has_ai_access(a.business_id)
      AND NOT EXISTS (SELECT 1 FROM alpha_whatsapp_reminders_sent r WHERE r.business_id = a.business_id)
    GROUP BY a.business_id, a.phone
    HAVING count(*) >= 3
  ),
  marked AS (
    INSERT INTO alpha_whatsapp_reminders_sent (business_id)
    SELECT q.business_id FROM qualifying q
    RETURNING business_id
  )
  SELECT m.business_id, q.phone, b.djomi_checkout_token
  FROM marked m
  JOIN qualifying q ON q.business_id = m.business_id
  JOIN businesses b ON b.id = m.business_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION get_and_mark_alpha_whatsapp_candidates() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_and_mark_alpha_whatsapp_candidates() TO service_role;
