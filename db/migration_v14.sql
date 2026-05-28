-- ============================================================
-- Patron — Migration v14
-- Run in Supabase SQL Editor AFTER migration_v13
-- ============================================================

-- The invite_codes UPDATE policy requires manager/admin role.
-- When a vendeur or investisseur joins using a code, they can't
-- increment `uses` directly. This SECURITY DEFINER function bypasses
-- that restriction so the counter is always updated correctly.

CREATE OR REPLACE FUNCTION public.use_invite_code(code_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE invite_codes
  SET uses = uses + 1
  WHERE id = code_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.use_invite_code(uuid) TO authenticated;
