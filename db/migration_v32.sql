-- ============================================================
-- Patron — Migration v32
-- Run in Supabase SQL Editor AFTER migration_v31
-- Fix: infinite recursion in memberships INSERT policy.
--
-- The v29/v31 INSERT policy does SELECT COUNT(*) FROM memberships
-- and SELECT EXISTS(...) FROM memberships inside the CHECK expression.
-- These subqueries trigger the SELECT RLS on memberships, which may
-- itself query memberships — causing Postgres to loop infinitely.
--
-- Fix: extract both checks into SECURITY DEFINER helper functions
-- that run as the function owner and bypass RLS entirely.
-- ============================================================

-- Helper 1: count non-admin memberships for a user (bypasses RLS)
CREATE OR REPLACE FUNCTION count_joined_businesses(p_user_id uuid)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT COUNT(*)
  FROM memberships
  WHERE user_id = p_user_id
    AND role != 'administrateur';
$$;

-- Helper 2: check whether a business already has a manager (bypasses RLS)
CREATE OR REPLACE FUNCTION business_has_manager(p_business_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM memberships
    WHERE business_id = p_business_id
      AND role = 'manager'
  );
$$;

GRANT EXECUTE ON FUNCTION count_joined_businesses(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION business_has_manager(uuid)    TO authenticated;

-- Recreate the INSERT policy using the helper functions instead of
-- inline subqueries, eliminating the recursion.
DROP POLICY IF EXISTS "Adhésion propre uniquement" ON memberships;

CREATE POLICY "Adhésion propre uniquement"
  ON memberships FOR INSERT WITH CHECK (
    user_id = auth.uid()
    AND count_joined_businesses(auth.uid()) < 3
    AND (
      role != 'manager'
      OR NOT business_has_manager(business_id)
    )
  );
