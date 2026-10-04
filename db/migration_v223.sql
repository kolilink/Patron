-- ============================================================
-- Patron — Migration v223
-- Run in Supabase SQL Editor AFTER migration_v222
--
-- Fix: finalize_account_deletion() (the daily cron's hard-delete
-- function, migration_v178) deletes a business with a bare
--   DELETE FROM businesses WHERE id = v_business_id;
-- relying entirely on ON DELETE CASCADE. migration_v217 already found
-- that four references to businesses(id) do NOT cascade:
--   * notification_log.business_id  (NOT NULL, no cascade)
--   * reconciliation_findings.business_id (nullable)
--   * businesses.referred_by_business_id  (nullable)
--   * partner_invite_codes.used_by_business_id (nullable)
-- leave_or_delete_business() was fixed in v217 to clean those up first,
-- but finalize_account_deletion() — a different code path (the 30-day
-- account-deletion cron, not the in-app "Quitter" button) — was left
-- with the same bug. So any business with real activity would make the
-- cron's delete FK-violate and leave the profile stranded (the loop
-- raises before memberships/profiles/auth.users are removed).
--
-- This migration is a superset of the v178 body: same due-check, same
-- admin/other-members re-check, same skip-instead-of-raise posture —
-- with the v217 four-step cleanup applied inside the loop before the
-- business delete.
-- ============================================================

CREATE OR REPLACE FUNCTION finalize_account_deletion(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business_id uuid;
  v_due         timestamptz;
BEGIN
  SELECT pending_deletion_at INTO v_due FROM profiles WHERE id = p_user_id;

  IF v_due IS NULL OR v_due > now() THEN
    RETURN; -- not (or no longer) due — cancelled, or called too early
  END IF;

  IF EXISTS (
    SELECT 1
    FROM   memberships m1
    WHERE  m1.user_id = p_user_id
    AND    m1.role    = 'administrateur'
    AND    EXISTS (
      SELECT 1
      FROM   memberships m2
      WHERE  m2.business_id = m1.business_id
      AND    m2.user_id    <> p_user_id
    )
  ) THEN
    -- Something added a co-member to a business this user solely administers
    -- since the request was scheduled — don't silently delete an admin out
    -- from under an active team. Clear the stale request instead of raising,
    -- so this doesn't block the rest of the day's batch.
    UPDATE profiles SET pending_deletion_at = NULL WHERE id = p_user_id;
    RETURN;
  END IF;

  FOR v_business_id IN
    SELECT m.business_id
    FROM   memberships m
    WHERE  m.user_id = p_user_id
    AND    m.role    = 'administrateur'
    AND    NOT EXISTS (
      SELECT 1 FROM memberships m2
      WHERE  m2.business_id = m.business_id
      AND    m2.user_id    <> p_user_id
    )
  LOOP
    -- v223: the same four non-cascading references
    -- leave_or_delete_business (v217) and delete_business (v165) clean up
    -- first. Without these, a business with real activity FK-violates the
    -- delete and strands the whole profile.
    DELETE FROM notification_log WHERE business_id = v_business_id;
    UPDATE reconciliation_findings SET business_id = NULL WHERE business_id = v_business_id;
    UPDATE businesses SET referred_by_business_id = NULL WHERE referred_by_business_id = v_business_id;
    UPDATE partner_invite_codes SET used_by_business_id = NULL WHERE used_by_business_id = v_business_id;

    DELETE FROM businesses WHERE id = v_business_id;
  END LOOP;

  DELETE FROM memberships WHERE user_id = p_user_id;
  DELETE FROM profiles WHERE id = p_user_id;
  DELETE FROM auth.users WHERE id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION finalize_account_deletion(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION finalize_account_deletion(uuid) TO service_role;
