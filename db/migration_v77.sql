-- v77: Demo mode helper
-- Adds a SECURITY DEFINER RPC used by the seed-demo-business Edge Function.
-- Called with service role; bypasses RLS and the business-created trigger
-- (which uses auth.uid() = NULL when invoked via service role).

CREATE OR REPLACE FUNCTION create_demo_business(
  p_user_id    uuid,
  p_business_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO businesses (id, name, currency, status, created_by)
  VALUES (p_business_id, 'Boutique Démo', 'GNF', 'actif', p_user_id);

  -- Insert membership directly: the normal trigger uses auth.uid() which is
  -- NULL under service role, so we set the user explicitly here.
  INSERT INTO memberships (user_id, business_id, role)
  VALUES (p_user_id, p_business_id, 'administrateur');
END;
$$;

-- Callable only via service role — prevent direct user invocation
REVOKE ALL ON FUNCTION create_demo_business(uuid, uuid) FROM anon, authenticated;
