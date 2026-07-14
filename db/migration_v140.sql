-- ============================================================
-- Patron — Migration v140
-- Run in Supabase SQL Editor AFTER migration_v139
--
-- Adds Djomi (Orange Money, api.djomy.africa) as a second, fully
-- out-of-app subscription path for Alpha Pro, alongside RevenueCat.
-- This is NOT an in-app purchase flow — see CLAUDE.md "Djomi out-of-
-- app subscription" — the checkout page lives entirely outside the app
-- (supabase/functions/djomi-checkout) and is never linked from inside
-- it, which is what keeps this compliant with Apple/Google's rules on
-- steering. The app only ever reads the same subscription_status /
-- subscription_expires_at / payment_provider columns RevenueCat writes.
-- ============================================================

ALTER TABLE businesses
  DROP CONSTRAINT IF EXISTS businesses_payment_provider_check,
  ADD CONSTRAINT businesses_payment_provider_check
    CHECK (payment_provider IS NULL OR payment_provider IN ('stripe', 'apple', 'google', 'promotional', 'djomi')),
  ADD COLUMN IF NOT EXISTS djomi_transaction_id TEXT;

-- resolve_business_for_djomi_checkout: the Djomi checkout page is an
-- unauthenticated web page (no Supabase session — the whole point is
-- it's reached outside the app), so it can't rely on auth.uid(). The
-- merchant instead types the same phone number their Patron account
-- uses; this looks it up by digits-only match (mirrors the comparison
-- style in src/utils/founder.ts) and returns the business they
-- administer. Only administrateurs can activate a subscription this
-- way — mirrors the existing model where subscription state lives on
-- the business, owned by its admin, never a manager/vendeur/investisseur.
-- Returns NULL (not an error) on no match or an ambiguous multi-admin
-- lookup, so the checkout page can show one generic "not found" message
-- without leaking which case occurred.
CREATE OR REPLACE FUNCTION resolve_business_for_djomi_checkout(p_phone TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_digits TEXT := regexp_replace(p_phone, '\D', '', 'g');
  v_business_id UUID;
  v_match_count INT;
BEGIN
  IF length(v_digits) < 8 THEN
    RETURN NULL;
  END IF;

  SELECT m.business_id, count(*) OVER ()
  INTO v_business_id, v_match_count
  FROM profiles p
  JOIN memberships m ON m.user_id = p.id AND m.role = 'administrateur'
  WHERE regexp_replace(p.phone, '\D', '', 'g') = v_digits
  LIMIT 2;

  IF v_match_count <> 1 THEN
    RETURN NULL;
  END IF;

  RETURN v_business_id;
END;
$$;

-- Only the djomi-checkout Edge Function (service_role) calls this —
-- an anon-callable phone->business lookup would be an enumeration
-- vector. Explicit revoke, not just relying on omission: this stack's
-- default privileges grant EXECUTE on new functions directly to anon/
-- authenticated, not just PUBLIC (see CLAUDE.md's REVOKE EXECUTE note
-- from migration_v137-v139).
REVOKE EXECUTE ON FUNCTION resolve_business_for_djomi_checkout(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION resolve_business_for_djomi_checkout(TEXT) TO service_role;

-- ─── djomi_pending_payments ──────────────────────────────────
-- Tracks a payment from the moment djomi-checkout creates it on
-- Djomi's side through to confirmation. Two things forced this table
-- to exist rather than keeping the flow stateless:
--
-- 1. Chicken-and-egg on the return URL: Djomi's payment-creation call
--    needs a returnUrl up front, but Djomi's own transactionId (needed
--    to later poll /v1/payments/{transactionId}) is only known from
--    THAT call's response — too late to embed in the URL we just sent
--    it. Solved by generating `reference` ourselves before the call,
--    inserting a row keyed by it, embedding only `reference` (never
--    the not-yet-known transactionId) in returnUrl, then updating the
--    row with transaction_id once the creation call responds.
--
-- 2. The account currently in use is shared with a friend's Djomi
--    project, and its one webhook slot already points at his endpoint
--    — so djomi-webhook realistically never fires (kept only as a
--    backstop). The real confirmation path is djomi-checkout polling
--    Djomi directly right after the merchant returns from paying, and
--    it needs somewhere trustworthy to resolve `reference` (client-
--    supplied, from the query string) back to a transaction_id and
--    business_id WITHOUT trusting anything else the client sends —
--    this table is that trust boundary. A tampered `ref` query param
--    can only ever point at one of our own previously-created pending
--    rows; it can never smuggle in an arbitrary transaction id or
--    redirect activation to a different business.
--
-- resolved_at: set the moment a payment is confirmed (by djomi-checkout's
-- poll, djomi-webhook, or djomi-sweep — see supabase/functions/djomi-sweep,
-- which handles the case a merchant pays but never returns to the
-- checkout tab within its ~2-minute poll window). NULL + still within
-- the sweep's lookback window = genuinely still unresolved.
CREATE TABLE IF NOT EXISTS djomi_pending_payments (
  reference      TEXT        PRIMARY KEY,
  business_id    UUID        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  transaction_id TEXT,
  resolved_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- service_role only, same posture as mystic_quota/support_ai_drafts —
-- no client (anon/authenticated) has any business reading or writing
-- this directly; RLS enabled with zero policies denies both by default.
ALTER TABLE djomi_pending_payments ENABLE ROW LEVEL SECURITY;
