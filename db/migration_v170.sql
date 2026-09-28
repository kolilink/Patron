-- migration_v170: Account deletion becomes a 30-day, cancellable, re-verified
-- request instead of an immediate, irreversible one — direct product request,
-- for security (make sure it's really the account owner asking) and to guard
-- against an impulsive/accidental tap permanently destroying data with no
-- recovery path.
--
-- Three pieces:
--   1. profiles.pending_deletion_at — NULL means no pending deletion. Set to
--      now() + 30 days when a deletion request is scheduled.
--   2. delete_my_account() no longer deletes anything itself. Same signature,
--      same self-service caller (auth.uid()), same upfront "blocked if
--      admin of a business with other active members" gate as before — it
--      now only *schedules* the deletion by stamping pending_deletion_at.
--      The client re-verifies the caller's phone via the existing
--      create-phone-verification/verify-phone-code OTP pair (NOT via
--      stores/auth.ts's loginWithPhone/verifyPhoneCode — those call
--      supabase.auth.signInAnonymously() and set the global `loading` flag,
--      both fine for the pre-login screen they were built for but actively
--      destructive if reused on an already-authenticated in-app session; see
--      the "Critical: auth store loading flag" note in CLAUDE.md) *before*
--      calling this RPC, so by the time this runs the caller has already
--      proven they still control the phone on file.
--   3. finalize_account_deletion(p_user_id) — service_role only, does the
--      actual irreversible delete (the exact cascade-delete-owned-businesses
--      + remove-memberships + delete-profile + delete-auth-user body
--      delete_my_account used to run inline). Called once per row by a daily
--      cron (see migration_v171) for every profile whose pending_deletion_at
--      has passed. Re-checks the admin/other-members gate again at finalize
--      time (cheap defense-in-depth — the caller was signed out immediately
--      after scheduling in the client flow, so nothing should have changed
--      underneath, but a function granted to service_role should never trust
--      a precondition established 30 days earlier without re-checking it) and
--      skips (does not raise) if pending_deletion_at is NULL or still in the
--      future, so a stray/duplicate call can't do anything.
--
-- Cancellation ("if they log in, we assume they don't want it deleted
-- anymore") is NOT a new RPC here — it's a plain `profiles` UPDATE from
-- stores/auth.ts's loadSession(), the single choke point every real
-- session-establishing path already runs through (cold start, phone OTP
-- login, biometric restore, email recovery). Already permitted by the
-- existing "Modifier son profil" RLS policy, same posture as
-- migration_v137's unread_notification_count reset.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS pending_deletion_at timestamptz;

-- ─── delete_my_account: schedule, don't delete ─────────────────────────────────

CREATE OR REPLACE FUNCTION delete_my_account()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_names   text;
BEGIN
  -- Real French copy, not an internal code — the client shows a bare
  -- RAISE's message verbatim whenever its SQLSTATE is P0001 (the default,
  -- same as every exception below), so a placeholder string here would leak
  -- to the screen exactly like a raw infrastructure error would. Effectively
  -- unreachable in real use (auth.uid() can't be null on an authenticated
  -- screen) but gets real copy anyway.
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Session invalide. Reconnectez-vous.';
  END IF;

  -- Block if admin of any business that has other active members — named
  -- explicitly (not a generic "a commerce"), same posture as
  -- leave_or_delete_business's own message (migration_v169), so whichever
  -- of the two blocks the request, the person is told exactly which
  -- business to sort out rather than left guessing among every business
  -- they belong to.
  SELECT string_agg(b.name, ', ')
    INTO v_names
    FROM memberships m1
    JOIN businesses  b ON b.id = m1.business_id
    WHERE m1.user_id = v_user_id
    AND   m1.role    = 'administrateur'
    AND   EXISTS (
      SELECT 1
      FROM   memberships m2
      WHERE  m2.business_id = m1.business_id
      AND    m2.user_id    <> v_user_id
    );

  IF v_names IS NOT NULL THEN
    RAISE EXCEPTION 'Vous êtes gérant de : %. Retirez tous les autres membres de ces commerces, ou quittez-les depuis Paramètres, avant de supprimer votre compte.', v_names
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE profiles
    SET pending_deletion_at = now() + interval '30 days'
    WHERE id = v_user_id;
END;
$$;

REVOKE ALL ON FUNCTION delete_my_account() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delete_my_account() TO authenticated;

-- ─── finalize_account_deletion: the actual, irreversible delete ───────────────

CREATE OR REPLACE FUNCTION finalize_account_deletion(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business_id uuid;
  v_due         timestamptz;
BEGIN
  SELECT pending_deletion_at INTO v_due FROM profiles WHERE id = p_user_id;

  IF v_due IS NULL OR v_due > now() THEN
    RETURN; -- not (or no longer) due — cancelled, or called too early
  END IF;

  IF EXISTS (
    SELECT 1
    FROM   memberships m1
    WHERE  m1.user_id = p_user_id
    AND    m1.role    = 'administrateur'
    AND    EXISTS (
      SELECT 1
      FROM   memberships m2
      WHERE  m2.business_id = m1.business_id
      AND    m2.user_id    <> p_user_id
    )
  ) THEN
    -- Something added a co-member to a business this user solely administers
    -- since the request was scheduled — don't silently delete an admin out
    -- from under an active team. Clear the stale request instead of raising,
    -- so this doesn't block the rest of the day's batch.
    UPDATE profiles SET pending_deletion_at = NULL WHERE id = p_user_id;
    RETURN;
  END IF;

  FOR v_business_id IN
    SELECT m.business_id
    FROM   memberships m
    WHERE  m.user_id = p_user_id
    AND    m.role    = 'administrateur'
    AND    NOT EXISTS (
      SELECT 1 FROM memberships m2
      WHERE  m2.business_id = m.business_id
      AND    m2.user_id    <> p_user_id
    )
  LOOP
    DELETE FROM businesses WHERE id = v_business_id;
  END LOOP;

  DELETE FROM memberships WHERE user_id = p_user_id;
  DELETE FROM profiles WHERE id = p_user_id;
  DELETE FROM auth.users WHERE id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION finalize_account_deletion(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION finalize_account_deletion(uuid) TO service_role;
