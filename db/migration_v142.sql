-- ============================================================
-- Patron — Migration v142
-- Run in Supabase SQL Editor AFTER migration_v141
--
-- Adds a per-business personalized-link token for the Djomi checkout
-- page — see CLAUDE.md's "Djomi out-of-app subscription" entry.
--
-- Today, every merchant hits the exact same generic URL
-- (patron.kolilink.com/abonnement) and has to type their Patron phone
-- number by hand to identify which business is paying. That manual
-- step is unavoidable for a shared, generic link — a website has no
-- way to know who's visiting a URL that's identical for everyone.
--
-- djomi_checkout_token exists so a FUTURE personalized link
-- (patron.kolilink.com/abonnement?biz=<token>), sent individually to
-- one business via WhatsApp, can skip that step entirely: the token
-- itself already identifies the business, so the checkout page only
-- needs to ask for the Orange Money number that's actually paying.
-- The manual phone-entry path (migration_v140.sql's
-- resolve_business_for_djomi_checkout) is untouched and remains the
-- fallback for anyone who reaches the page some other way (forwarded
-- link, bookmarked, typed from memory).
--
-- Mirrors migration_v130.sql's referral_code pattern exactly (same
-- generation approach, same backfill-on-migrate + trigger-on-insert
-- shape) — proven safe-enough for this codebase's low-stakes,
-- non-financial-data-exposing identifiers. Lowercase + 10 chars (vs.
-- referral_code's 6 uppercase) purely for extra collision headroom
-- and less guessability, since this one gates a payment action rather
-- than just tagging a referral relationship — still deliberately not
-- treated as a high-security secret: paying for the wrong business by
-- guessing a token isn't a data-exposure or fraud risk, just a wasted
-- payment, same posture as the manual phone-entry path today.
-- ============================================================

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS djomi_checkout_token TEXT UNIQUE;

CREATE OR REPLACE FUNCTION generate_djomi_checkout_token()
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  candidate TEXT;
  tries INT := 0;
BEGIN
  LOOP
    candidate := lower(substr(md5(random()::text || clock_timestamp()::text), 1, 10));
    EXIT WHEN NOT EXISTS (SELECT 1 FROM businesses WHERE djomi_checkout_token = candidate);
    tries := tries + 1;
    IF tries > 20 THEN
      RAISE EXCEPTION 'Could not generate a unique djomi checkout token after % tries', tries;
    END IF;
  END LOOP;
  RETURN candidate;
END;
$$;

CREATE OR REPLACE FUNCTION set_business_djomi_checkout_token()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.djomi_checkout_token IS NULL THEN
    NEW.djomi_checkout_token := generate_djomi_checkout_token();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS businesses_set_djomi_checkout_token ON businesses;
CREATE TRIGGER businesses_set_djomi_checkout_token
  BEFORE INSERT ON businesses
  FOR EACH ROW EXECUTE FUNCTION set_business_djomi_checkout_token();

-- Backfill existing businesses so every one already has a usable token
-- the moment the WhatsApp sender exists — no separate migration needed
-- later just to backfill stragglers.
UPDATE businesses
SET djomi_checkout_token = generate_djomi_checkout_token()
WHERE djomi_checkout_token IS NULL;

-- resolve_business_by_djomi_checkout_token: the token itself IS the
-- identification — it's only ever distributed via a direct message to
-- that business's own admin (once the WhatsApp sender exists), so no
-- additional role/ownership check layers on top, same posture as
-- resolve_business_for_djomi_checkout's phone lookup.
CREATE OR REPLACE FUNCTION resolve_business_by_djomi_checkout_token(p_token TEXT)
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT id FROM businesses WHERE djomi_checkout_token = lower(trim(p_token));
$$;

-- service_role only — same explicit-revoke reasoning as every other
-- service-role RPC in this file's neighborhood (see CLAUDE.md's
-- REVOKE EXECUTE note from migration_v137-v139).
REVOKE EXECUTE ON FUNCTION resolve_business_by_djomi_checkout_token(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION resolve_business_by_djomi_checkout_token(TEXT) TO service_role;
