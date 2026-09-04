-- migration_v169: leave_or_delete_business(p_business_id) — one action for
-- everyone, replacing what used to be two separate, role-conditional buttons
-- in Paramètres ("Quitter ce commerce" for non-admins, a would-be "Supprimer
-- ce commerce" for admins).
--
-- First-principles simplification: "quitting" a business is really only one
-- idea — I don't want to be part of this anymore — and the correct outcome
-- for that idea already depends entirely on who else is there, so the app
-- should decide it, not the user:
--   · not the admin           → just remove your own membership. Always
--                                allowed, never destroys anything, since
--                                the business carries on for whoever's left.
--   · admin, alone            → quitting IS deleting: there's nobody left
--                                for the business to exist for, so the
--                                business (products, sales, expenses — all
--                                cascade via the same `on delete cascade`
--                                FKs delete_my_account already relies on)
--                                is removed outright.
--   · admin, others present   → refused outright, on purpose. No
--                                auto-promoting a successor, no "pick who
--                                takes over" prompt — just a plain, named
--                                instruction to remove the other members
--                                first. A business with active employees
--                                should never lose its admin as a silent
--                                side effect of one tap.
--
-- Client is a single "Quitter {business}" row for every role — no more
-- separate admin-only delete button. The exception message names the
-- business directly so the client can show it verbatim, no re-derivation
-- needed on the client side.

CREATE OR REPLACE FUNCTION leave_or_delete_business(p_business_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_role    text;
  v_name    text;
BEGIN
  -- Every RAISE EXCEPTION here is real, French, user-facing copy, not an
  -- internal code — the client shows a bare RAISE's message verbatim
  -- whenever its SQLSTATE is P0001 (the default for a plain RAISE EXCEPTION,
  -- same as every other exception below), so an English/placeholder string
  -- here would leak to the screen exactly like a raw infrastructure error.
  -- These two are effectively unreachable in real use (auth.uid() can't be
  -- null on an authenticated screen; p_business_id always comes from the
  -- caller's own already-loaded active business) but get real copy anyway.
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Session invalide. Reconnectez-vous.';
  END IF;

  v_role := get_role(p_business_id);
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Vous n''êtes pas membre de ce commerce.';
  END IF;

  IF v_role <> 'administrateur' THEN
    DELETE FROM memberships WHERE business_id = p_business_id AND user_id = v_user_id;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM memberships
    WHERE business_id = p_business_id AND user_id <> v_user_id
  ) THEN
    SELECT name INTO v_name FROM businesses WHERE id = p_business_id;
    RAISE EXCEPTION '% a d''autres membres actifs. Retirez-les avant de le quitter.', COALESCE(v_name, 'Ce commerce')
      USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM businesses WHERE id = p_business_id;
END;
$$;

REVOKE ALL ON FUNCTION leave_or_delete_business(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION leave_or_delete_business(uuid) TO authenticated;
