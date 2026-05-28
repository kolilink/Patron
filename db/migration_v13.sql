-- ============================================================
-- Patron — Migration v13
-- Run in Supabase SQL Editor AFTER migration_v12
-- ============================================================

-- Clears the is_anonymous flag on the calling user's auth.users row.
-- Called from upgradePhone() after phone verification succeeds, so that
-- RESTRICTIVE RLS policies (e.g. anon_memberships_own_only on memberships)
-- stop blocking the user from seeing other team members.

CREATE OR REPLACE FUNCTION public.upgrade_anonymous_user()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE auth.users
  SET is_anonymous = false,
      updated_at   = now()
  WHERE id = auth.uid()
    AND is_anonymous = true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.upgrade_anonymous_user() TO authenticated;
