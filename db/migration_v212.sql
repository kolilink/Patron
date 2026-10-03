-- ============================================================
-- Patron — Migration v212
-- Run in Supabase SQL Editor AFTER migration_v211
-- ============================================================
-- P0-3: manager self-promotion guard.
--
-- Problem:
--   The memberships UPDATE policy ("Admins/Managers: modifier les rôles",
--   migration_v21) lets BOTH administrateurs and managers edit a member's
--   row — including the `role` column. A manager could therefore promote
--   themselves (or a teammate) to administrateur, and a sole
--   administrateur could demote themselves and leave the business with no
--   admin at all.
--
-- Fix:
--   RLS stays permissive for admin/manager (so managers can still edit
--   non-role columns like display_name / scope_all_products), but a
--   BEFORE UPDATE OF role trigger enforces:
--     1. only an administrateur may change `role`;
--     2. the last administrateur cannot be demoted.
--   The trigger is SECURITY DEFINER (set search_path = public) so it can
--   read memberships / call count_business_admins() without RLS recursion.
--
-- Safe to re-run (DROP IF EXISTS + CREATE OR REPLACE).

DROP TRIGGER IF EXISTS memberships_role_guard ON memberships;
DROP FUNCTION IF EXISTS memberships_prevent_role_escalation();

CREATE OR REPLACE FUNCTION memberships_prevent_role_escalation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only an administrateur may change a member's role. get_role() resolves
  -- the CALLER's role in OLD.business_id via auth.uid(), so a manager (or
  -- any non-admin) editing any role row in that business is rejected.
  IF get_role(OLD.business_id) IS DISTINCT FROM 'administrateur' THEN
    RAISE EXCEPTION
      'Seul un administrateur peut modifier les rôles'
      USING ERRCODE = 'P0001';
  END IF;

  -- The last administrateur cannot be demoted (or promoted away from the
  -- admin role by any edit that changes `role` to something else).
  IF OLD.role = 'administrateur'
     AND NEW.role IS DISTINCT FROM 'administrateur'
     AND count_business_admins(OLD.business_id) <= 1 THEN
    RAISE EXCEPTION
      'Impossible de rétrograder le dernier administrateur'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER memberships_role_guard
  BEFORE UPDATE OF role ON memberships
  FOR EACH ROW
  EXECUTE FUNCTION memberships_prevent_role_escalation();
