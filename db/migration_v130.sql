-- ============================================================
-- Patron — Migration v130
-- Run in Supabase SQL Editor AFTER migration_v129
--
-- Re-launches the subscription paywall (see PaywallScreen.tsx /
-- app/(app)/_layout.tsx — currently hardcoded off) via native
-- Apple/Google IAP (RevenueCat) instead of the old in-app Stripe
-- Payment Link flow, which was a Guideline 3.1.1 risk (a digital
-- subscription unlocking in-app functionality must go through
-- platform IAP, not a web checkout opened via Linking.openURL).
--
-- payment_provider records who currently owns the active/last
-- subscription record. NULL = never subscribed (still trialing).
-- Written by supabase/functions/stripe-webhook (stripe, legacy/
-- future web-only path) or supabase/functions/revenuecat-webhook
-- (apple / google / promotional).
--
-- revenuecat_customer_id is RevenueCat's app_user_id, which by
-- convention equals businesses.id (Purchases.logIn(business.id)
-- is called from stores/auth.ts) — stored here defensively for
-- support lookups in the RevenueCat dashboard.
--
-- bonus_access_until / referred_by_business_id back the referral
-- program ("Inviter un ami" in Paramètres): referring a business
-- whose trial converts to a real paid subscription grants both
-- businesses 30 bonus days. This is deliberately a field separate
-- from subscription_expires_at, which is owned entirely by the
-- IAP webhook and gets overwritten on every renewal — writing the
-- bonus there would silently get clobbered by the next renewal
-- event. bonus_access_until stacks on top of whatever IAP is
-- doing instead of fighting it (see isSubscriptionExpired in
-- app/(app)/_layout.tsx).
-- ============================================================

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS payment_provider TEXT
    CONSTRAINT businesses_payment_provider_check
    CHECK (payment_provider IS NULL OR payment_provider IN ('stripe', 'apple', 'google', 'promotional')),
  ADD COLUMN IF NOT EXISTS revenuecat_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS bonus_access_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS referred_by_business_id UUID REFERENCES businesses(id),
  ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE;

-- Backfill: any business with an active Stripe subscription today
-- is unambiguously a 'stripe' payer.
UPDATE businesses
SET payment_provider = 'stripe'
WHERE stripe_subscription_id IS NOT NULL AND payment_provider IS NULL;

-- ============================================================
-- referral_code: short, human-shareable code shown in Paramètres
-- ("Inviter un ami") and entered by a new business at signup
-- (app/(app)/onboarding/creer.tsx) to set referred_by_business_id.
-- Generated server-side (not client Math.random(), unlike invite
-- codes in migration_v21 — this one needs a uniqueness guarantee,
-- which is cheap to enforce here with a retry loop against the real
-- UNIQUE constraint, and doesn't have that migration's rate-limit
-- concerns since it's generated once per business, not guessed at).
-- ============================================================

CREATE OR REPLACE FUNCTION generate_business_referral_code()
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  candidate TEXT;
  tries INT := 0;
BEGIN
  LOOP
    candidate := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
    EXIT WHEN NOT EXISTS (SELECT 1 FROM businesses WHERE referral_code = candidate);
    tries := tries + 1;
    IF tries > 20 THEN
      RAISE EXCEPTION 'Could not generate a unique referral code after % tries', tries;
    END IF;
  END LOOP;
  RETURN candidate;
END;
$$;

CREATE OR REPLACE FUNCTION set_business_referral_code()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.referral_code IS NULL THEN
    NEW.referral_code := generate_business_referral_code();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS businesses_set_referral_code ON businesses;
CREATE TRIGGER businesses_set_referral_code
  BEFORE INSERT ON businesses
  FOR EACH ROW EXECUTE FUNCTION set_business_referral_code();

-- Backfill existing businesses with a code too, so the "Inviter un ami"
-- section has something to show immediately, not just for new signups.
UPDATE businesses
SET referral_code = generate_business_referral_code()
WHERE referral_code IS NULL;

-- resolve_referral_code: a brand-new user creating their first business is
-- not yet a member of anyone's business, so the "Membres: voir leur
-- commerce" SELECT policy (is_member(id)) blocks a plain client-side
-- lookup of the referrer's business by code. SECURITY DEFINER bypasses
-- that for this one narrow, safe read (a code that only reveals a UUID,
-- not any business data) — same shape as validate_invite_code.
CREATE OR REPLACE FUNCTION resolve_referral_code(p_code TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business_id UUID;
BEGIN
  SELECT id INTO v_business_id
  FROM businesses
  WHERE referral_code = upper(trim(p_code));

  RETURN v_business_id; -- NULL if no match; caller treats that as invalid code
END;
$$;

GRANT EXECUTE ON FUNCTION resolve_referral_code(TEXT) TO authenticated;

-- Note: subscription_tier (schema.sql — gratuit/starter/business/pro) is
-- legacy and intentionally NOT touched by this migration. It was never
-- wired to any gating logic and stayed permanently 'gratuit'. It was,
-- however, silently shipping that constant into every PostHog identify/
-- group call via lib/analytics.ts — fixed in the same PR as this migration
-- by removing those two reads (subscription_status is the real signal and
-- was already captured separately). The column itself is left in place;
-- dropping it is destructive for no benefit. Do not wire the new IAP flow
-- into subscription_tier — this migration's model is a single flat paid
-- subscription, not tiers.
