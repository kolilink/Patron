-- ============================================================
-- Patron — Migration v209
-- Run in Supabase SQL Editor AFTER migration_v208
--
-- Founder measurement layer (spec: patron-measurement/measurement-spec.md,
-- mirrored in docs/measurement.md). Everything the in-app founder KPI
-- screen reads, computed server-side, founder-only.
--
--   1. is_test on profiles + businesses. The founder's own account and every
--      business it creates are test by construction (backfill + trigger).
--      A business is excluded from EVERY KPI below when it is flagged, its
--      creator is flagged, or its creator never verified a phone (demo /
--      abandoned anonymous sessions — same rule as migration_v175/v182).
--   2. funnel_devices — a durable, device-keyed log of the two funnel steps
--      the business tables cannot see: install and OTP. Written by the
--      client (offline-queued) through record_funnel_step(). Chosen over
--      reading phone_verifications (login rows are deleted after use, and
--      it has no notion of install) and over PostHog (the spec forbids the
--      founder screen depending on the PostHog query API).
--   3. consumer_invites: fixes v206's pgcrypto search_path (create /
--      preview / resolve could not find gen_random_bytes/hmac on
--      Supabase). Expired-unused invites are now marked 'expired'
--      instead of DELETEd, so "invites created" stops under-counting.
--      list_my_consumer_invites() hides them, so the merchant UI is
--      unchanged.
--   4. kpi_businesses / kpi_core_actions views + get_founder_kpis():
--      the 7 dashboard blocks in one founder-gated round trip.
--   5. Three saved call-list views + get_founder_call_lists().
--   6. set_business_is_test() — founder-only, to flag team/test shops
--      straight from the call lists.
--   7. The legacy growth_metrics view / get_founder_growth_stats() now
--      apply the same is_test filter (older app builds still call them),
--      and the legacy North Star query stops counting demo businesses.
--
-- Every view here is REVOKEd from anon/authenticated: reachable only
-- through the founder-gated SECURITY DEFINER RPCs (or the SQL editor).
-- ============================================================

-- ─── 1. is_test ──────────────────────────────────────────────

ALTER TABLE profiles   ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;

UPDATE profiles SET is_test = true
 WHERE regexp_replace(COALESCE(phone, ''), '\D', '', 'g') = '12672421843'
   AND NOT is_test;

UPDATE businesses b SET is_test = true
  FROM profiles p
 WHERE p.id = b.created_by AND p.is_test AND NOT b.is_test;

-- A business created by a test account is test from its first row.
CREATE OR REPLACE FUNCTION public.inherit_business_is_test()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM profiles WHERE id = NEW.created_by AND is_test) THEN
    NEW.is_test := true;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS businesses_inherit_is_test ON businesses;
CREATE TRIGGER businesses_inherit_is_test
  BEFORE INSERT ON businesses
  FOR EACH ROW EXECUTE FUNCTION public.inherit_business_is_test();

-- A profile whose phone becomes the founder's is test (covers the founder
-- re-registering on a fresh account).
CREATE OR REPLACE FUNCTION public.mark_founder_profile_test()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF regexp_replace(COALESCE(NEW.phone, ''), '\D', '', 'g') = '12672421843' THEN
    NEW.is_test := true;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_mark_founder_test ON profiles;
CREATE TRIGGER profiles_mark_founder_test
  BEFORE INSERT OR UPDATE OF phone ON profiles
  FOR EACH ROW EXECUTE FUNCTION public.mark_founder_profile_test();

-- ─── 2. funnel_devices ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS funnel_devices (
  device_id        uuid PRIMARY KEY,
  platform         text,
  installed_at     timestamptz,
  otp_sent_at      timestamptz,
  otp_verified_at  timestamptz,
  user_id          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  is_test          boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS funnel_devices_installed_idx ON funnel_devices (installed_at);
CREATE INDEX IF NOT EXISTS funnel_devices_user_idx ON funnel_devices (user_id) WHERE user_id IS NOT NULL;

-- No client policy at all: written only via record_funnel_step(), read
-- only via get_founder_kpis().
ALTER TABLE funnel_devices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON funnel_devices FROM PUBLIC, anon, authenticated;

-- Steps:
--   'installed'    — first open. installed_at keeps the EARLIEST value seen.
--   'otp_sent'     — sign-up flow only (creer.tsx), first value kept.
--   'otp_verified' — sign-up flow only; also links user_id = auth.uid(),
--                    the anonymous user that upgradePhone() keeps, i.e.
--                    the future businesses.created_by.
--   'seen'         — any session on this device; only ever sets is_test.
-- p_is_test can only turn the flag ON. Callable by anon because install
-- happens before any session exists. Client timestamps are clamped.
CREATE OR REPLACE FUNCTION public.record_funnel_step(
  p_device_id uuid,
  p_step      text,
  p_at        timestamptz DEFAULT NULL,
  p_platform  text        DEFAULT NULL,
  p_is_test   boolean     DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_at   timestamptz := LEAST(now(), GREATEST(COALESCE(p_at, now()), now() - interval '400 days'));
  v_test boolean := COALESCE(p_is_test, false)
                    OR (v_uid IS NOT NULL AND EXISTS (SELECT 1 FROM profiles WHERE id = v_uid AND is_test));
BEGIN
  IF p_device_id IS NULL OR p_step NOT IN ('installed', 'otp_sent', 'otp_verified', 'seen') THEN
    RAISE EXCEPTION 'Étape invalide' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO funnel_devices (device_id, platform)
  VALUES (p_device_id, left(p_platform, 16))
  ON CONFLICT (device_id) DO NOTHING;

  UPDATE funnel_devices SET
    platform        = COALESCE(platform, left(p_platform, 16)),
    -- A device already linked to a different (real) merchant is never
    -- flagged by someone else's test session — e.g. the founder logging in
    -- on a merchant's phone during assisted onboarding.
    is_test         = is_test OR (v_test AND (user_id IS NULL OR user_id = v_uid)),
    installed_at    = CASE WHEN p_step = 'installed'
                           THEN LEAST(COALESCE(installed_at, v_at), v_at) ELSE installed_at END,
    otp_sent_at     = CASE WHEN p_step = 'otp_sent'
                           THEN COALESCE(otp_sent_at, v_at) ELSE otp_sent_at END,
    otp_verified_at = CASE WHEN p_step = 'otp_verified'
                           THEN COALESCE(otp_verified_at, v_at) ELSE otp_verified_at END,
    user_id         = CASE WHEN p_step = 'otp_verified'
                           THEN COALESCE(user_id, v_uid) ELSE user_id END,
    updated_at      = now()
  WHERE device_id = p_device_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_funnel_step(uuid, text, timestamptz, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_funnel_step(uuid, text, timestamptz, text, boolean) TO anon, authenticated;

-- ─── 3. consumer_invites: mark expired, never delete ─────────

ALTER TABLE consumer_invites DROP CONSTRAINT IF EXISTS consumer_invites_status_check;
ALTER TABLE consumer_invites ADD CONSTRAINT consumer_invites_status_check
  CHECK (status IN ('active', 'revoked', 'used', 'expired'));

CREATE OR REPLACE FUNCTION public.create_consumer_invite()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_uid        uuid := auth.uid();
  v_key        text;
  v_token      text;
  v_code       text;
  v_alphabet   text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; -- 32 chars, no I/L/O/U
  v_token_hash text;
  v_code_hash  text;
  v_invite_id  uuid;
  v_inviter_name text;
  v_active     int;
  v_expires    timestamptz := now() + interval '24 hours';
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Connexion requise' USING ERRCODE = 'P0001';
  END IF;

  -- v209: expired links are marked, not deleted — the founder's
  -- "invites created" count needs the row. Still frees the soft cap.
  UPDATE consumer_invites SET status = 'expired'
   WHERE inviter_id = v_uid AND status = 'active' AND expires_at <= now();

  SELECT count(*) INTO v_active
    FROM consumer_invites
   WHERE inviter_id = v_uid AND status = 'active';
  IF v_active >= 50 THEN
    RAISE EXCEPTION 'Trop d''invitations actives. Réessayez plus tard.' USING ERRCODE = 'P0001';
  END IF;

  v_key := (SELECT value FROM app_secrets WHERE key = 'invite_hmac_key');
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'Invitation invalide' USING ERRCODE = 'P0001';
  END IF;

  v_token := encode(gen_random_bytes(24), 'hex');

  v_code := '';
  FOR _i IN 1..10 LOOP
    v_code := v_code || substr(v_alphabet, (get_byte(gen_random_bytes(1), 0) % 32) + 1, 1);
  END LOOP;

  v_token_hash := encode(hmac(convert_to(v_token, 'utf8'), convert_to(v_key, 'utf8'), 'sha256'), 'hex');
  v_code_hash  := encode(hmac(convert_to(upper(v_code), 'utf8'), convert_to(v_key, 'utf8'), 'sha256'), 'hex');

  SELECT NULLIF(btrim(COALESCE(name, '')), '') INTO v_inviter_name
    FROM profiles WHERE id = v_uid;

  v_invite_id := gen_random_uuid();
  INSERT INTO consumer_invites (id, inviter_id, token_hash, code_hash, status, expires_at, inviter_name)
  VALUES (v_invite_id, v_uid, v_token_hash, v_code_hash, 'active', v_expires, v_inviter_name);

  RETURN jsonb_build_object(
    'id',         v_invite_id,
    'token',      v_token,
    'code',       v_code,
    'expires_at', v_expires
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_consumer_invite() TO authenticated;

-- v206 pinned search_path = public, but on Supabase pgcrypto
-- (gen_random_bytes, hmac) lives in the `extensions` schema — every
-- create/preview/resolve call failed with "function ... does not exist".
-- Found by this migration's own integration test.
ALTER FUNCTION public.resolve_consumer_invite(text, text) SET search_path = public, extensions;
ALTER FUNCTION public.preview_consumer_invite(text)       SET search_path = public, extensions;

-- Same shape as v206; only hides 'expired' rows, which used to be deleted.
CREATE OR REPLACE FUNCTION public.list_my_consumer_invites()
RETURNS TABLE (
  id            uuid,
  status        text,
  created_at    timestamptz,
  expires_at    timestamptz,
  used_at       timestamptz,
  used_by       uuid,
  used_by_name  text,
  revoked_at    timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT ci.id, ci.status, ci.created_at, ci.expires_at, ci.used_at,
         ci.used_by, COALESCE(NULLIF(p.name, ''), 'Ton ami'), ci.revoked_at
    FROM consumer_invites ci
    LEFT JOIN profiles p ON p.id = ci.used_by
   WHERE ci.inviter_id = auth.uid()
     AND ci.status <> 'expired'
   ORDER BY ci.created_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.list_my_consumer_invites() TO authenticated;

-- ─── 4. KPI views ────────────────────────────────────────────

-- One row per REAL business (never test, never demo/anonymous).
-- first_value_at = first sale or credit entry (spec §1 first_value_action).
CREATE OR REPLACE VIEW kpi_businesses AS
SELECT
  b.id         AS business_id,
  b.name       AS business_name,
  b.created_at AS created_at,
  b.created_by AS created_by,
  p.name       AS owner_name,
  p.phone      AS owner_phone,
  (b.referred_by_business_id IS NOT NULL
    OR EXISTS (SELECT 1 FROM consumer_invites ci
                WHERE ci.used_by = b.created_by AND ci.status = 'used')) AS is_referred,
  (SELECT min(so.created_at) FROM sale_orders so
    WHERE so.business_id = b.id AND so.status IN ('paye', 'credit')) AS first_value_at
FROM businesses b
JOIN profiles p ON p.id = b.created_by
WHERE NOT b.is_test
  AND NOT p.is_test
  AND p.phone IS NOT NULL AND p.phone <> '';

REVOKE ALL ON kpi_businesses FROM PUBLIC, anon, authenticated;

-- Core actions (spec §1 core loop, minus app_opened which is not an action):
-- a sale or credit entry, a repayment (a payment made after the order was
-- created — the payment written atomically with a sale is part of that
-- sale), a product added.
CREATE OR REPLACE VIEW kpi_core_actions AS
SELECT so.business_id, so.created_at AS at, 'sale'::text AS kind
  FROM sale_orders so
  JOIN kpi_businesses kb ON kb.business_id = so.business_id
 WHERE so.status IN ('paye', 'credit')
UNION ALL
SELECT pay.business_id, pay.created_at, 'repayment'
  FROM payments pay
  JOIN sale_orders so ON so.id = pay.order_id
  JOIN kpi_businesses kb ON kb.business_id = pay.business_id
 WHERE pay.amount > 0
   AND pay.voided_at IS NULL
   AND pay.created_at > so.created_at + interval '1 minute'
UNION ALL
SELECT pr.business_id, pr.created_at, 'product'
  FROM products pr
  JOIN kpi_businesses kb ON kb.business_id = pr.business_id
 WHERE NOT pr.is_system;

REVOKE ALL ON kpi_core_actions FROM PUBLIC, anon, authenticated;

-- ─── 5. Call lists (saved queries) ───────────────────────────

CREATE OR REPLACE VIEW kpi_business_activity AS
SELECT
  kb.*,
  (SELECT max(a.at) FROM kpi_core_actions a WHERE a.business_id = kb.business_id) AS last_action_at,
  (SELECT count(*) FROM kpi_core_actions a
    WHERE a.business_id = kb.business_id AND a.at >= now() - interval '7 days') AS actions_7d,
  (SELECT count(DISTINCT a.at::date) FROM kpi_core_actions a
    WHERE a.business_id = kb.business_id AND a.at >= now() - interval '7 days') AS active_days_7d
FROM kpi_businesses kb;

REVOKE ALL ON kpi_business_activity FROM PUBLIC, anon, authenticated;

-- New this week → welcome call.
CREATE OR REPLACE VIEW call_list_welcome AS
SELECT * FROM kpi_business_activity
 WHERE created_at >= now() - interval '7 days'
 ORDER BY created_at DESC;

-- Activated, then silent for 7+ days → interview call.
CREATE OR REPLACE VIEW call_list_interview AS
SELECT * FROM kpi_business_activity
 WHERE first_value_at IS NOT NULL
   AND (last_action_at IS NULL OR last_action_at < now() - interval '7 days')
 ORDER BY last_action_at DESC NULLS LAST;

-- Power users (a core action on 4+ of the last 7 days) → referral ask.
CREATE OR REPLACE VIEW call_list_referral AS
SELECT * FROM kpi_business_activity
 WHERE active_days_7d >= 4
 ORDER BY actions_7d DESC;

REVOKE ALL ON call_list_welcome   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON call_list_interview FROM PUBLIC, anon, authenticated;
REVOKE ALL ON call_list_referral  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_founder_call_lists()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  v_cols text := 'business_id, business_name, owner_name, owner_phone, created_at, first_value_at, last_action_at, actions_7d, active_days_7d';
  v_welcome   jsonb;
  v_interview jsonb;
  v_referral  jsonb;
BEGIN
  IF NOT is_founder() THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;
  EXECUTE format('SELECT COALESCE(jsonb_agg(t), ''[]''::jsonb) FROM (SELECT %s FROM call_list_welcome LIMIT 50) t', v_cols) INTO v_welcome;
  EXECUTE format('SELECT COALESCE(jsonb_agg(t), ''[]''::jsonb) FROM (SELECT %s FROM call_list_interview LIMIT 50) t', v_cols) INTO v_interview;
  EXECUTE format('SELECT COALESCE(jsonb_agg(t), ''[]''::jsonb) FROM (SELECT %s FROM call_list_referral LIMIT 50) t', v_cols) INTO v_referral;
  RETURN jsonb_build_object('welcome', v_welcome, 'interview', v_interview, 'referral', v_referral);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_founder_call_lists() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_founder_call_lists() TO authenticated;

-- ─── 6. The 7 blocks ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_founder_kpis()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  v_north   jsonb;
  v_funnel  jsonb;
  v_act     jsonb;
  v_ret     jsonb;
  v_ref     jsonb;
BEGIN
  IF NOT is_founder() THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  -- 1. North Star: businesses with ≥1 core action in a trailing 7d window,
  --    for the current week and the 7 before it (index 0 = current).
  SELECT jsonb_build_object(
    'weekly', (
      SELECT jsonb_agg(c ORDER BY k)
        FROM (
          SELECT k, (SELECT count(DISTINCT a.business_id) FROM kpi_core_actions a
                      WHERE a.at >= now() - ((k + 1) * interval '7 days')
                        AND a.at <  now() - (k * interval '7 days')) AS c
            FROM generate_series(0, 7) AS k
        ) w),
    'total_real_businesses', (SELECT count(*) FROM kpi_businesses)
  ) INTO v_north;

  -- 2. Funnel: devices first opened in the last 30 days.
  WITH d AS (
    SELECT fd.installed_at, fd.otp_sent_at, fd.otp_verified_at,
           kb.created_at AS commerce_at, kb.first_value_at
      FROM funnel_devices fd
      LEFT JOIN profiles pu ON pu.id = fd.user_id
      LEFT JOIN LATERAL (
        SELECT k.created_at, k.first_value_at FROM kpi_businesses k
         WHERE k.created_by = fd.user_id
         ORDER BY k.created_at LIMIT 1
      ) kb ON true
     WHERE NOT fd.is_test
       AND NOT COALESCE(pu.is_test, false)
       AND fd.installed_at >= now() - interval '30 days'
  )
  SELECT jsonb_build_object(
    'installed',    count(*),
    'otp_sent',     count(otp_sent_at),
    'otp_verified', count(otp_verified_at),
    'commerce',     count(commerce_at),
    'first_value',  count(first_value_at),
    'median_s', jsonb_build_object(
      'install_to_otp_sent',      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM otp_sent_at - installed_at)),
      'otp_sent_to_verified',     percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM otp_verified_at - otp_sent_at)),
      'verified_to_commerce',     percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM commerce_at - otp_verified_at)),
      'commerce_to_first_value',  percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first_value_at - commerce_at))
    ),
    'ttfv_install_median_s', percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first_value_at - installed_at)),
    'ttfv_install_n',        count(first_value_at),
    'devices_all_time',      (SELECT count(*) FROM funnel_devices WHERE NOT is_test)
  ) INTO v_funnel
  FROM d;

  -- 3. Activation: businesses created in the last 30 days with a first
  --    value; TTFV measured from commerce creation (always available).
  SELECT jsonb_build_object(
    'cohort',    count(*) FILTER (WHERE created_at >= now() - interval '30 days'),
    'activated', count(*) FILTER (WHERE created_at >= now() - interval '30 days' AND first_value_at IS NOT NULL),
    'ttfv_commerce_median_s', percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first_value_at - created_at))
                                FILTER (WHERE created_at >= now() - interval '90 days'),
    'ttfv_commerce_n', count(first_value_at) FILTER (WHERE created_at >= now() - interval '90 days'),
    'ttfv_under_24h', count(*) FILTER (WHERE created_at >= now() - interval '90 days'
                                         AND first_value_at <= created_at + interval '24 hours')
  ) INTO v_act
  FROM kpi_businesses;

  -- 4. Retention of activated businesses, relative to their first value:
  --    W1 = a core action in days [7,14), W4 = in days [28,35). Only
  --    businesses whose window has fully elapsed are in the cohort.
  SELECT jsonb_build_object(
    'w1_cohort',   count(*) FILTER (WHERE first_value_at <= now() - interval '14 days'),
    'w1_retained', count(*) FILTER (WHERE first_value_at <= now() - interval '14 days' AND EXISTS (
                      SELECT 1 FROM kpi_core_actions a WHERE a.business_id = kb.business_id
                         AND a.at >= kb.first_value_at + interval '7 days'
                         AND a.at <  kb.first_value_at + interval '14 days')),
    'w4_cohort',   count(*) FILTER (WHERE first_value_at <= now() - interval '35 days'),
    'w4_retained', count(*) FILTER (WHERE first_value_at <= now() - interval '35 days' AND EXISTS (
                      SELECT 1 FROM kpi_core_actions a WHERE a.business_id = kb.business_id
                         AND a.at >= kb.first_value_at + interval '28 days'
                         AND a.at <  kb.first_value_at + interval '35 days'))
  ) INTO v_ret
  FROM kpi_businesses kb
  WHERE kb.first_value_at IS NOT NULL;

  -- 5. Referral four numbers, trailing 30 days.
  WITH active AS (
    SELECT DISTINCT business_id FROM kpi_core_actions WHERE at >= now() - interval '30 days'
  ), real_invites AS (
    SELECT ci.* FROM consumer_invites ci
      JOIN profiles p ON p.id = ci.inviter_id
     WHERE NOT p.is_test
       AND ci.created_at >= now() - interval '30 days'
  ), sharing AS (
    SELECT DISTINCT a.business_id FROM active a
      JOIN memberships m ON m.business_id = a.business_id
      JOIN real_invites ri ON ri.inviter_id = m.user_id
  ), quality AS (
    SELECT is_referred, count(*) AS n, count(first_value_at) AS activated
      FROM kpi_businesses
     WHERE created_at >= now() - interval '90 days'
     GROUP BY is_referred
  )
  SELECT jsonb_build_object(
    'active_30d',          (SELECT count(*) FROM active),
    'sharing_30d',         (SELECT count(*) FROM sharing),
    'invites_created_30d', (SELECT count(*) FROM real_invites),
    'invites_used_30d',    (SELECT count(*) FROM real_invites WHERE status = 'used'),
    'referred_signups_30d',(SELECT count(*) FROM kpi_businesses
                             WHERE is_referred AND created_at >= now() - interval '30 days'),
    'referred_n',          COALESCE((SELECT n FROM quality WHERE is_referred), 0),
    'referred_activated',  COALESCE((SELECT activated FROM quality WHERE is_referred), 0),
    'organic_n',           COALESCE((SELECT n FROM quality WHERE NOT is_referred), 0),
    'organic_activated',   COALESCE((SELECT activated FROM quality WHERE NOT is_referred), 0)
  ) INTO v_ref;

  RETURN jsonb_build_object(
    'generated_at', now(),
    'north_star',   v_north,
    'funnel',       v_funnel,
    'activation',   v_act,
    'retention',    v_ret,
    'referral',     v_ref
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_founder_kpis() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_founder_kpis() TO authenticated;

-- ─── 7. Founder: flag a business as test ─────────────────────

CREATE OR REPLACE FUNCTION public.set_business_is_test(p_business_id uuid, p_is_test boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_founder() THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;
  UPDATE businesses SET is_test = COALESCE(p_is_test, true) WHERE id = p_business_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_business_is_test(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_business_is_test(uuid, boolean) TO authenticated;

-- ─── 8. Legacy founder stats: same is_test filter ────────────

CREATE OR REPLACE VIEW growth_metrics AS
WITH biz AS (
  SELECT b.id AS business_id, b.created_at AS signup_at
  FROM businesses b
  JOIN profiles p ON p.id = b.created_by
  WHERE p.phone IS NOT NULL AND p.phone <> ''
    AND NOT b.is_test AND NOT p.is_test
)
SELECT
  biz.business_id,
  biz.signup_at,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM products pr
      WHERE pr.business_id = biz.business_id
        AND pr.created_at <= biz.signup_at + interval '72 hours'
    ) OR EXISTS (
      SELECT 1 FROM sale_orders so
      WHERE so.business_id = biz.business_id
        AND so.status != 'annule'
        AND so.created_at <= biz.signup_at + interval '72 hours'
    ) THEN true
    WHEN now() >= biz.signup_at + interval '72 hours' THEN false
    ELSE NULL
  END AS activated_72h,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM sale_orders so
      WHERE so.business_id = biz.business_id
        AND so.status IN ('paye', 'credit')
        AND so.sale_date >= (biz.signup_at::date + 7)
        AND so.sale_date <  (biz.signup_at::date + 14)
    ) THEN true
    WHEN now() >= biz.signup_at + interval '14 days' THEN false
    ELSE NULL
  END AS week1_retained,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM sale_orders so
      WHERE so.business_id = biz.business_id
        AND so.status IN ('paye', 'credit')
        AND so.sale_date >= (biz.signup_at::date + 28)
        AND so.sale_date <  (biz.signup_at::date + 35)
    ) THEN true
    WHEN now() >= biz.signup_at + interval '35 days' THEN false
    ELSE NULL
  END AS week4_retained
FROM biz;

REVOKE ALL ON growth_metrics FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION get_founder_growth_stats()
RETURNS TABLE (
  activation_rate_pct      numeric,
  week1_retention_pct      numeric,
  week4_retention_pct      numeric,
  weekly_transacting_shops bigint,
  total_real_businesses    bigint
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
    (SELECT count(*) FILTER (WHERE activated_72h) * 100.0 / NULLIF(count(*), 0)
       FROM growth_metrics
       WHERE signup_at >= now() - interval '30 days'),
    (SELECT count(*) FILTER (WHERE week1_retained) * 100.0 / NULLIF(count(*) FILTER (WHERE activated_72h), 0)
       FROM growth_metrics
       WHERE activated_72h),
    (SELECT count(*) FILTER (WHERE week4_retained) * 100.0 / NULLIF(count(*) FILTER (WHERE activated_72h), 0)
       FROM growth_metrics
       WHERE activated_72h),
    -- v209: was every business with a sale, demo/test included.
    (SELECT count(DISTINCT so.business_id) FROM sale_orders so
       JOIN growth_metrics gm ON gm.business_id = so.business_id
       WHERE so.status IN ('paye', 'credit')
         AND so.sale_date >= now() - interval '7 days'),
    (SELECT count(*) FROM growth_metrics);
END;
$$;

REVOKE EXECUTE ON FUNCTION get_founder_growth_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_founder_growth_stats() TO authenticated;
