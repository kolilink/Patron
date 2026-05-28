-- ============================================================
-- Patron — Migration v17
-- Run in Supabase SQL Editor AFTER migration_v16
-- ============================================================

-- The memberships table had no UPDATE or DELETE policies.
-- RLS blocks all writes by default, so changeRole and removeMembre
-- were silently failing — the optimistic local update made it look
-- like it worked, but the DB row was never changed.

DROP POLICY IF EXISTS "Managers: modifier les rôles des membres" ON memberships;
DROP POLICY IF EXISTS "Managers: retirer des membres"           ON memberships;

CREATE POLICY "Managers: modifier les rôles des membres"
  ON memberships FOR UPDATE
  USING (get_role(business_id) IN ('administrateur', 'manager'))
  WITH CHECK (get_role(business_id) IN ('administrateur', 'manager'));

CREATE POLICY "Managers: retirer des membres"
  ON memberships FOR DELETE
  USING (get_role(business_id) IN ('administrateur', 'manager'));
