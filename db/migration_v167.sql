-- migration_v167: Fix get_founder_activity_raw() counting non-users as users.
--
-- Found while investigating why the Founder Dashboard's growth KPIs looked
-- broken: "Actifs transactionnels (jour)" reading 0.3%, "Ventes / utilisateur
-- actif" landing suspiciously exactly on 3.0, and "Rétention D7" frequently
-- showing "--". The founderMetrics.ts formulas themselves are correct
-- (traced line by line) -- the bug is upstream, in what this RPC counts as
-- a "user":
--
-- 1. Every phone-auth attempt -- login (stores/auth.ts loginWithPhone) or
--    register (createPhoneVerification) -- calls signInAnonymously() and
--    upserts a `profiles` row BEFORE OTP verification succeeds. An abandoned
--    attempt (never enters the code, or gives up) leaves a permanent
--    profiles row with signup_at set and phone still null. Login specifically
--    leaves one of these behind on every attempt, success or not, since a
--    successful login discards the throwaway anonymous session and swaps
--    the user into their real, pre-existing account via magic link.
-- 2. Every demo-mode "Essayer" tap (stores/auth.ts startDemoMode) is the
--    same signInAnonymously() + blank-phone profiles upsert, plus
--    seed-demo-business seeds 12 fully-fake sale_orders under that same
--    anonymous user's own seller_id -- including exactly 3 dated "today"
--    and one at exactly "7 days ago". Those rows pass this RPC's
--    so.status != 'annule' filter with no way to tell them apart from a
--    real sale, which is exactly why avg-transactions-per-active-user was
--    landing near the seeded constant (3.0) instead of a real signal.
--
-- Neither case is a real registered user. Both share one trait real users
-- always have and these never do: profiles.phone IS NULL for both, since
-- phone is only ever set by upgradePhone() on a real conversion. This is
-- the same "real user" filter already used elsewhere in this codebase
-- (migration_v143.sql, v145.sql, v149.sql's Alpha WhatsApp reminder
-- targeting) -- not a new convention.
--
-- This does NOT clean up sale_orders/products/etc. left behind by demo
-- businesses or abandoned anonymous accounts elsewhere in the app; it only
-- fixes what this one founder-only growth-metrics RPC counts.

CREATE OR REPLACE FUNCTION get_founder_activity_raw()
RETURNS TABLE (
  user_id        uuid,
  signup_at      timestamptz,
  transaction_at timestamptz[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
BEGIN
  IF NOT is_founder() THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  SELECT
    p.id,
    p.created_at,
    COALESCE(
      array_agg(so.created_at ORDER BY so.created_at) FILTER (WHERE so.created_at IS NOT NULL),
      ARRAY[]::timestamptz[]
    )
  FROM profiles p
  LEFT JOIN sale_orders so
    ON so.seller_id = p.id AND so.status != 'annule'
  WHERE p.phone IS NOT NULL AND p.phone <> ''
  GROUP BY p.id, p.created_at;
END;
$$;

REVOKE EXECUTE ON FUNCTION get_founder_activity_raw() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_founder_activity_raw() TO authenticated;
