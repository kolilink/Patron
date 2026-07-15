-- ============================================================
-- Patron — Migration v149
-- Run in Supabase SQL Editor AFTER migration_v148
--
-- Fix: get_and_mark_alpha_whatsapp_candidates() has raised
-- "column reference business_id is ambiguous" on every real call since
-- it first shipped in migration_v143.sql — found via live testing,
-- not caught by anything static, since this is a PL/pgSQL execution-
-- time ambiguity, not a SQL syntax error.
--
-- Root cause: RETURNS TABLE(business_id uuid, ...) implicitly creates
-- a PL/pgSQL variable named business_id in the function's scope. Every
-- reference to business_id in the query body was already correctly
-- table-qualified (m.business_id, ac.business_id, q.business_id, etc.)
-- EXCEPT one: the `marked` CTE's `INSERT ... RETURNING business_id` —
-- an unqualified RETURNING column defaults to referencing the target
-- table's column, but Postgres can't disambiguate that from the
-- enclosing function's same-named OUT parameter variable, so every
-- call errored before returning anything. Since djomi-sweep's
-- CRON_SECRET/Vault mismatch (fixed earlier the same session) was
-- ALSO masking this — every scheduled call 401'd before ever reaching
-- this function — this bug had been silently present and untested
-- since v143.sql shipped.
--
-- Fix: `INSERT INTO alpha_whatsapp_reminders_sent AS awrs (...)` gives
-- the target table an explicit alias, so `RETURNING awrs.business_id`
-- unambiguously means the table column, not the PL/pgSQL variable.
-- Postgres has supported aliasing the INSERT target specifically for
-- this kind of RETURNING disambiguation.
--
-- Per this project's convention, migration_v143.sql/v145.sql (the
-- earlier versions of this same function) are left as historical
-- record, not edited retroactively — this migration is the fix,
-- applied forward via CREATE OR REPLACE with the same signature.
-- ============================================================

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
    INSERT INTO alpha_whatsapp_reminders_sent AS awrs (business_id)
    SELECT q.business_id FROM qualifying q
    RETURNING awrs.business_id
  )
  SELECT m.business_id, q.phone, b.djomi_checkout_token
  FROM marked m
  JOIN qualifying q ON q.business_id = m.business_id
  JOIN businesses b ON b.id = m.business_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION get_and_mark_alpha_whatsapp_candidates() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_and_mark_alpha_whatsapp_candidates() TO service_role;
