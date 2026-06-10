-- ============================================================
-- Patron — Migration v47
-- Run in Supabase SQL Editor AFTER migration_v46
--
-- Adds subscription tracking to the businesses table:
--   subscription_status     — trialing | active | cancelled | expired
--   trial_ends_at           — when the 30-day free trial ends
--   stripe_customer_id      — set by the stripe-webhook Edge Function
--   stripe_subscription_id  — set by the stripe-webhook Edge Function
--   subscription_expires_at — current billing period end (from Stripe)
-- ============================================================

ALTER TABLE businesses
  ADD COLUMN subscription_status TEXT NOT NULL DEFAULT 'trialing'
    CONSTRAINT businesses_subscription_status_check
    CHECK (subscription_status IN ('trialing', 'active', 'cancelled', 'expired')),
  ADD COLUMN trial_ends_at TIMESTAMPTZ,
  ADD COLUMN stripe_customer_id TEXT,
  ADD COLUMN stripe_subscription_id TEXT,
  ADD COLUMN subscription_expires_at TIMESTAMPTZ;

-- Backfill existing businesses: 60-day trial from today as a courtesy
-- to early adopters who have been using the app without a paywall.
UPDATE businesses
SET trial_ends_at = now() + INTERVAL '60 days'
WHERE trial_ends_at IS NULL;

-- Trigger: auto-set trial_ends_at = now() + 30 days on INSERT
CREATE OR REPLACE FUNCTION set_business_trial_ends_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.trial_ends_at IS NULL THEN
    NEW.trial_ends_at := now() + INTERVAL '30 days';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER businesses_set_trial_ends_at
  BEFORE INSERT ON businesses
  FOR EACH ROW EXECUTE FUNCTION set_business_trial_ends_at();
