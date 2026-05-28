-- ============================================================
-- Patron — Migration v15
-- Run in Supabase SQL Editor AFTER migration_v14
-- ============================================================

-- ── Fix 1: memberships visibility for phone-verified users ───────────────
--
-- The old RESTRICTIVE policy keyed on `jwt->>'is_anonymous'`, which is only
-- cleared after upgradePhone() + refreshSession() succeeds. In practice the
-- JWT often lags or the RPC silently fails, so the policy kept blocking
-- phone-verified managers from seeing their teammates.
--
-- New rule: an anonymous user who already has a phone in their profile is
-- considered verified and may see all membership rows for their business.
-- Unverified anonymous users (no phone) still only see their own row.

DROP POLICY IF EXISTS "anon_memberships_own_only" ON memberships;

CREATE POLICY "anon_memberships_own_only"
  ON memberships AS RESTRICTIVE FOR SELECT
  TO authenticated
  USING (
    -- Fully authenticated (non-anonymous) users — unrestricted
    (SELECT (auth.jwt()->>'is_anonymous')::boolean) IS NOT TRUE
    OR
    -- Phone-verified anonymous users — unrestricted
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid() AND phone IS NOT NULL
    )
    OR
    -- Unverified anonymous users — own row only
    user_id = auth.uid()
  );

-- ── Fix 2: allow teammates to see each other's profiles ──────────────────
--
-- The existing "Voir son profil" policy only exposes your own profile row.
-- The Equipe screen embeds profiles via .select('*, user:profiles(name, email, phone)'),
-- so without this policy teammate names and phones always come back null.

DROP POLICY IF EXISTS "Équipe: voir les profils des membres" ON profiles;

CREATE POLICY "Équipe: voir les profils des membres"
  ON profiles FOR SELECT
  USING (
    -- Can see profile P if P's owner is a member of any business I'm also in.
    -- is_member() is SECURITY DEFINER so it bypasses profiles/memberships RLS.
    EXISTS (
      SELECT 1 FROM memberships
      WHERE user_id  = profiles.id
        AND is_member(business_id)
    )
  );
