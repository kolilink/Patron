-- migration_v23: delete_my_account() RPC
-- Allows a user to permanently delete their own account.
-- Blocks deletion if they are admin of a business that still has other members.
-- Deletes: businesses they solely own (cascade), their memberships, their profile, their auth user.

CREATE OR REPLACE FUNCTION delete_my_account()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id     uuid := auth.uid();
  v_business_id uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  -- Block if admin of any business that has other active members
  IF EXISTS (
    SELECT 1
    FROM   memberships m1
    WHERE  m1.user_id = v_user_id
    AND    m1.role    = 'administrateur'
    AND    EXISTS (
      SELECT 1
      FROM   memberships m2
      WHERE  m2.business_id = m1.business_id
      AND    m2.user_id    <> v_user_id
    )
  ) THEN
    RAISE EXCEPTION 'admin_has_members'
      USING HINT = 'Remove all members or transfer your role before deleting your account.';
  END IF;

  -- Delete businesses where this user is the sole admin (cascade handles related data)
  FOR v_business_id IN
    SELECT m.business_id
    FROM   memberships m
    WHERE  m.user_id = v_user_id
    AND    m.role    = 'administrateur'
    AND    NOT EXISTS (
      SELECT 1 FROM memberships m2
      WHERE  m2.business_id = m.business_id
      AND    m2.user_id    <> v_user_id
    )
  LOOP
    DELETE FROM businesses WHERE id = v_business_id;
  END LOOP;

  -- Remove remaining memberships (non-admin businesses)
  DELETE FROM memberships WHERE user_id = v_user_id;

  -- Remove profile
  DELETE FROM profiles WHERE id = v_user_id;

  -- Delete the auth user (runs as postgres/superuser via SECURITY DEFINER)
  DELETE FROM auth.users WHERE id = v_user_id;
END;
$$;

-- Only the authenticated user can call this on themselves
REVOKE ALL ON FUNCTION delete_my_account() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delete_my_account() TO authenticated;
