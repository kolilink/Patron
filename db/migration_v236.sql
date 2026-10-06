-- ============================================================
-- migration_v236 — word-of-mouth invite: inviter attribution
--
-- The invite is now a plain link, patron.kolilink.com/invite/<inviter-id>:
-- no code, no expiry, no single-use token. Two RPCs back it:
--   preview_inviter(p_inviter_id)          anon  — landing page headline name
--   record_invite_attribution(p_inviter_id) authed — silent, once per invitee
-- The consumer_invites machinery (v206/v209/v212/v216) is left in place,
-- unused by the client; nothing is dropped.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.invite_attributions (
  invitee_id  uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  inviter_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (invitee_id <> inviter_id)
);

CREATE INDEX IF NOT EXISTS invite_attributions_inviter_idx
  ON public.invite_attributions (inviter_id);

-- Service-role / SQL-editor only: RLS on, no policy, no grants.
ALTER TABLE public.invite_attributions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.invite_attributions FROM PUBLIC, anon, authenticated;

-- Landing page: the inviter's display name, nothing else. The id is an
-- unguessable uuid, same exposure posture as preview_consumer_invite.
CREATE OR REPLACE FUNCTION public.preview_inviter(p_inviter_id uuid)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT jsonb_build_object('valid', true, 'inviter_name', NULLIF(btrim(p.name), ''))
       FROM profiles p
      WHERE p.id = p_inviter_id
        AND p.phone IS NOT NULL AND p.phone <> ''),
    jsonb_build_object('valid', false, 'inviter_name', NULL)
  );
$$;

REVOKE EXECUTE ON FUNCTION public.preview_inviter(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.preview_inviter(uuid) TO anon, authenticated;

-- Silent attribution: first writer wins, self / unknown inviter / repeat are
-- no-ops reported as recorded=false (never an exception — the client clears
-- its pending id on any definitive answer and only retries on network errors).
CREATE OR REPLACE FUNCTION public.record_invite_attribution(p_inviter_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_me uuid := auth.uid();
  v_rows int;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'Connexion requise.';
  END IF;
  IF p_inviter_id IS NULL OR p_inviter_id = v_me THEN
    RETURN jsonb_build_object('recorded', false);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_inviter_id AND phone IS NOT NULL AND phone <> '') THEN
    RETURN jsonb_build_object('recorded', false);
  END IF;
  INSERT INTO invite_attributions (invitee_id, inviter_id)
  VALUES (v_me, p_inviter_id)
  ON CONFLICT (invitee_id) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('recorded', v_rows > 0);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_invite_attribution(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_invite_attribution(uuid) TO authenticated;

-- Founder metrics: a plain count of installs that came through an invite link
-- (no rate, no funnel). Real businesses' owners only — test/demo accounts
-- excluded. iOS cold installs are unattributable (no clipboard handoff), so
-- this undercounts iOS.
CREATE OR REPLACE FUNCTION public.get_founder_invite_installs()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT is_founder() THEN
    RAISE EXCEPTION 'Accès refusé';
  END IF;
  RETURN (
    SELECT count(*)
      FROM invite_attributions ia
      JOIN profiles p ON p.id = ia.invitee_id
     WHERE COALESCE(p.is_test, false) = false
       AND p.phone IS NOT NULL AND p.phone <> ''
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_founder_invite_installs() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_founder_invite_installs() TO authenticated;
