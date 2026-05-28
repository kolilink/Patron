-- ============================================================
-- Patron — Migration v16
-- Run in Supabase SQL Editor AFTER migration_v15
-- Fixes the infinite-recursion introduced by v15.
-- ============================================================

-- v15 created two policies that referenced each other:
--   memberships RESTRICTIVE → queried profiles (for phone check)
--   profiles "Équipe" policy → queried memberships (for teammate check)
-- PostgreSQL detected the loop and threw on every auth/profile query.
-- Fix: wrap both checks in SECURITY DEFINER functions so they bypass RLS
-- and cannot re-enter the policies that called them.

-- ── Helper: does the calling user have a verified phone? ──────────────────
CREATE OR REPLACE FUNCTION public.caller_has_verified_phone()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid() AND phone IS NOT NULL
  );
$$;

-- ── Helper: do two users share at least one business? ─────────────────────
CREATE OR REPLACE FUNCTION public.shares_business_with(other_user_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM memberships m1
    JOIN memberships m2
      ON m1.business_id = m2.business_id
    WHERE m1.user_id = auth.uid()
      AND m2.user_id = other_user_id
  );
$$;

GRANT EXECUTE ON FUNCTION public.caller_has_verified_phone()    TO authenticated;
GRANT EXECUTE ON FUNCTION public.shares_business_with(uuid)     TO authenticated;

-- ── Fix memberships RESTRICTIVE policy ───────────────────────────────────
DROP POLICY IF EXISTS "anon_memberships_own_only" ON memberships;

CREATE POLICY "anon_memberships_own_only"
  ON memberships AS RESTRICTIVE FOR SELECT
  TO authenticated
  USING (
    -- Non-anonymous users: unrestricted
    (SELECT (auth.jwt()->>'is_anonymous')::boolean) IS NOT TRUE
    OR
    -- Phone-verified anonymous users: unrestricted
    -- (SECURITY DEFINER — cannot recurse into memberships RLS)
    caller_has_verified_phone()
    OR
    -- Unverified anonymous users: own row only
    user_id = auth.uid()
  );

-- ── Fix profiles teammate policy ─────────────────────────────────────────
DROP POLICY IF EXISTS "Équipe: voir les profils des membres" ON profiles;

CREATE POLICY "Équipe: voir les profils des membres"
  ON profiles FOR SELECT
  USING (
    -- SECURITY DEFINER — cannot recurse into profiles RLS
    shares_business_with(profiles.id)
  );
