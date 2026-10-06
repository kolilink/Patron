-- ============================================================
-- migration_v238 — founder KPI rebuild (5 cards) + founder "new user" alert
--
-- PART A (founder KPI screen)
--   1. founder_outreach_log — the one input metric the founder fully
--      controls ("vendeurs contactés cette semaine"). Founder-only, written
--      through log_founder_outreach().
--   2. get_founder_kpis() — SUPERSET of the v209 body: every existing key is
--      kept byte-for-byte in meaning; new keys carry the previous-period
--      figures the cards need for a trend, the "< 24 h" cohort (a real
--      cohort, not "among those who already activated"), invite installs
--      (same test/demo exclusion as get_founder_invite_installs, v236),
--      the outreach counts, the lost-vendor count, and excluded_test (how
--      many test/demo businesses the denominators leave out — so the
--      exclusion is visible on screen instead of taken on faith).
--   3. get_founder_vendor_directory() — the phone-number list the founder
--      texts from (every REAL business, owner name + phone).
--
-- PART B (founder push on a new business)
--   4. founder_new_user_alerts — one row per business (PK business_id =
--      exactly-once), holds the exact title/body/route/recipient the push
--      carries. An AFTER INSERT trigger on businesses writes it and calls
--      dispatch-notification via pg_net (same mechanism as v148/v170).
--      The trigger can never block business creation: everything is inside
--      an exception handler.
--
-- Test/demo exclusion is never re-implemented here: every figure goes through
-- kpi_businesses / kpi_core_actions (v209), which drop is_test businesses,
-- is_test owners and phone-less (demo / abandoned anonymous) owners.
-- ============================================================

-- ─── 1. Outreach log ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.founder_outreach_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contacted_at  timestamptz NOT NULL DEFAULT now(),
  channel       text NOT NULL CHECK (channel IN ('whatsapp', 'appel', 'sms', 'visite', 'autre')),
  contact_name  text,
  note          text,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS founder_outreach_log_contacted_idx
  ON public.founder_outreach_log (contacted_at DESC);

ALTER TABLE public.founder_outreach_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.founder_outreach_log FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.log_founder_outreach(
  p_channel      text,
  p_contact_name text DEFAULT NULL,
  p_note         text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT COALESCE(is_founder(), false) THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;
  IF p_channel IS NULL OR p_channel NOT IN ('whatsapp', 'appel', 'sms', 'visite', 'autre') THEN
    RAISE EXCEPTION 'Canal invalide' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO founder_outreach_log (channel, contact_name, note, created_by)
  VALUES (p_channel, left(NULLIF(btrim(p_contact_name), ''), 120), left(NULLIF(btrim(p_note), ''), 500), auth.uid())
  RETURNING id INTO v_id;
  RETURN jsonb_build_object(
    'id', v_id,
    'this_week', (SELECT count(*) FROM founder_outreach_log
                   WHERE contacted_at >= date_trunc('week', now() AT TIME ZONE 'Africa/Conakry') AT TIME ZONE 'Africa/Conakry')
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.log_founder_outreach(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_founder_outreach(text, text, text) TO authenticated;

-- ─── 2. Shared invite-install count (same exclusion as v236) ─

CREATE OR REPLACE FUNCTION public.founder_invite_installs_between(p_from timestamptz, p_to timestamptz)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT count(*)
    FROM invite_attributions ia
    JOIN profiles p ON p.id = ia.invitee_id
   WHERE COALESCE(p.is_test, false) = false
     AND p.phone IS NOT NULL AND p.phone <> ''
     AND (p_from IS NULL OR ia.created_at >= p_from)
     AND (p_to   IS NULL OR ia.created_at <  p_to);
$$;

-- Internal helper: callable only from inside the definer functions below.
REVOKE EXECUTE ON FUNCTION public.founder_invite_installs_between(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;

-- ─── 3. get_founder_kpis() — superset of v209 ────────────────

CREATE OR REPLACE FUNCTION public.get_founder_kpis()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
DECLARE
  v_north   jsonb;
  v_funnel  jsonb;
  v_act     jsonb;
  v_ret     jsonb;
  v_ref     jsonb;
  v_out     jsonb;
  v_week_start timestamptz := date_trunc('week', now() AT TIME ZONE 'Africa/Conakry') AT TIME ZONE 'Africa/Conakry';
BEGIN
  IF NOT is_founder() THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  -- 1. North Star (v209 body) + how many test/demo businesses are left out.
  SELECT jsonb_build_object(
    'weekly', (
      SELECT jsonb_agg(c ORDER BY k)
        FROM (
          SELECT k, (SELECT count(DISTINCT a.business_id) FROM kpi_core_actions a
                      WHERE a.at >= now() - ((k + 1) * interval '7 days')
                        AND a.at <  now() - (k * interval '7 days')) AS c
            FROM generate_series(0, 7) AS k
        ) w),
    'total_real_businesses', (SELECT count(*) FROM kpi_businesses),
    'excluded_test',         (SELECT count(*) FROM businesses b
                               WHERE b.id NOT IN (SELECT business_id FROM kpi_businesses))
  ) INTO v_north;

  -- 2. Funnel (v209 body, unchanged).
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

  -- 3. Activation: v209 keys + the "< 24 h" cohort, current vs previous 30 d.
  --    u24 cohort = businesses created 24 h..30 d ago (younger ones haven't
  --    had their 24 h yet, so they can't be judged); prev = 30..60 d ago.
  SELECT jsonb_build_object(
    'cohort',    count(*) FILTER (WHERE created_at >= now() - interval '30 days'),
    'activated', count(*) FILTER (WHERE created_at >= now() - interval '30 days' AND first_value_at IS NOT NULL),
    'ttfv_commerce_median_s', percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first_value_at - created_at))
                                FILTER (WHERE created_at >= now() - interval '90 days'),
    'ttfv_commerce_n', count(first_value_at) FILTER (WHERE created_at >= now() - interval '90 days'),
    'ttfv_under_24h', count(*) FILTER (WHERE created_at >= now() - interval '90 days'
                                         AND first_value_at <= created_at + interval '24 hours'),
    'u24_cohort', count(*) FILTER (WHERE created_at >= now() - interval '30 days'
                                     AND created_at <= now() - interval '24 hours'),
    'u24_hit',    count(*) FILTER (WHERE created_at >= now() - interval '30 days'
                                     AND created_at <= now() - interval '24 hours'
                                     AND first_value_at <= created_at + interval '24 hours'),
    'u24_prev_cohort', count(*) FILTER (WHERE created_at >= now() - interval '60 days'
                                          AND created_at <  now() - interval '30 days'),
    'u24_prev_hit',    count(*) FILTER (WHERE created_at >= now() - interval '60 days'
                                          AND created_at <  now() - interval '30 days'
                                          AND first_value_at <= created_at + interval '24 hours')
  ) INTO v_act
  FROM kpi_businesses;

  -- 4. Retention: v209 keys + "recent" (window closed in the last 30 d) vs
  --    "prev" (the 30 d before) cohorts, for a trend that isn't swamped by
  --    the all-time cumulative number.
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
                         AND a.at <  kb.first_value_at + interval '35 days')),
    'w1_recent_cohort',   count(*) FILTER (WHERE first_value_at <= now() - interval '14 days'
                                              AND first_value_at >  now() - interval '44 days'),
    'w1_recent_retained', count(*) FILTER (WHERE first_value_at <= now() - interval '14 days'
                                              AND first_value_at >  now() - interval '44 days' AND EXISTS (
                      SELECT 1 FROM kpi_core_actions a WHERE a.business_id = kb.business_id
                         AND a.at >= kb.first_value_at + interval '7 days'
                         AND a.at <  kb.first_value_at + interval '14 days')),
    'w1_prev_cohort',     count(*) FILTER (WHERE first_value_at <= now() - interval '44 days'
                                              AND first_value_at >  now() - interval '74 days'),
    'w1_prev_retained',   count(*) FILTER (WHERE first_value_at <= now() - interval '44 days'
                                              AND first_value_at >  now() - interval '74 days' AND EXISTS (
                      SELECT 1 FROM kpi_core_actions a WHERE a.business_id = kb.business_id
                         AND a.at >= kb.first_value_at + interval '7 days'
                         AND a.at <  kb.first_value_at + interval '14 days')),
    'w4_recent_cohort',   count(*) FILTER (WHERE first_value_at <= now() - interval '35 days'
                                              AND first_value_at >  now() - interval '65 days'),
    'w4_recent_retained', count(*) FILTER (WHERE first_value_at <= now() - interval '35 days'
                                              AND first_value_at >  now() - interval '65 days' AND EXISTS (
                      SELECT 1 FROM kpi_core_actions a WHERE a.business_id = kb.business_id
                         AND a.at >= kb.first_value_at + interval '28 days'
                         AND a.at <  kb.first_value_at + interval '35 days')),
    'w4_prev_cohort',     count(*) FILTER (WHERE first_value_at <= now() - interval '65 days'
                                              AND first_value_at >  now() - interval '95 days'),
    'w4_prev_retained',   count(*) FILTER (WHERE first_value_at <= now() - interval '65 days'
                                              AND first_value_at >  now() - interval '95 days' AND EXISTS (
                      SELECT 1 FROM kpi_core_actions a WHERE a.business_id = kb.business_id
                         AND a.at >= kb.first_value_at + interval '28 days'
                         AND a.at <  kb.first_value_at + interval '35 days')),
    'lost_count', (SELECT count(*) FROM call_list_interview)
  ) INTO v_ret
  FROM kpi_businesses kb
  WHERE kb.first_value_at IS NOT NULL;

  -- 5. Referral (v209 keys) + invite installs with the v236 exclusion.
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
    'organic_activated',   COALESCE((SELECT activated FROM quality WHERE NOT is_referred), 0),
    'invite_installs_total',   founder_invite_installs_between(NULL, NULL),
    'invite_installs_30d',     founder_invite_installs_between(now() - interval '30 days', NULL),
    'invite_installs_prev_30d', founder_invite_installs_between(now() - interval '60 days', now() - interval '30 days')
  ) INTO v_ref;

  -- 6. Outreach: calendar weeks in Africa/Conakry (named, never the session zone).
  SELECT jsonb_build_object(
    'this_week', count(*) FILTER (WHERE contacted_at >= v_week_start),
    'prev_week', count(*) FILTER (WHERE contacted_at >= v_week_start - interval '7 days'
                                    AND contacted_at <  v_week_start),
    'total',     count(*)
  ) INTO v_out
  FROM founder_outreach_log;

  RETURN jsonb_build_object(
    'generated_at', now(),
    'north_star',   v_north,
    'funnel',       v_funnel,
    'activation',   v_act,
    'retention',    v_ret,
    'referral',     v_ref,
    'outreach',     v_out
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_founder_kpis() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_founder_kpis() TO authenticated;

-- ─── 4. Vendor directory (the phone-number list) ─────────────

CREATE OR REPLACE FUNCTION public.get_founder_vendor_directory()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT COALESCE(is_founder(), false) THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(t ORDER BY t.lost DESC, t.last_action_at DESC NULLS LAST, t.created_at DESC)
      FROM (
        SELECT business_id, business_name, owner_name, owner_phone, created_at,
               first_value_at, last_action_at, actions_7d,
               (first_value_at IS NOT NULL
                AND (last_action_at IS NULL OR last_action_at < now() - interval '7 days')) AS lost
          FROM kpi_business_activity
      ) t
  ), '[]'::jsonb);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_founder_vendor_directory() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_founder_vendor_directory() TO authenticated;

-- ─── 5. Founder push when a new business is created ──────────

CREATE TABLE IF NOT EXISTS public.founder_new_user_alerts (
  business_id        uuid PRIMARY KEY REFERENCES public.businesses(id) ON DELETE CASCADE,
  recipient_user_id  uuid NOT NULL,
  title              text NOT NULL,
  body               text NOT NULL,
  route              text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.founder_new_user_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.founder_new_user_alerts FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.notify_founder_new_business()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_founder uuid;
  v_rows    int;
  v_name    text;
BEGIN
  -- Never let an alert problem block business creation.
  BEGIN
    -- Test businesses (founder's own, team shops) and demo / anonymous
    -- owners (no verified phone) are not "new users".
    IF COALESCE(NEW.is_test, false) THEN RETURN NEW; END IF;
    IF NOT EXISTS (SELECT 1 FROM profiles p
                    WHERE p.id = NEW.created_by
                      AND NOT COALESCE(p.is_test, false)
                      AND p.phone IS NOT NULL AND p.phone <> '') THEN
      RETURN NEW;
    END IF;

    v_founder := get_founder_id();
    IF v_founder IS NULL THEN RETURN NEW; END IF;

    v_name := left(COALESCE(NULLIF(btrim(NEW.name), ''), 'Un commerce'), 60);

    INSERT INTO founder_new_user_alerts (business_id, recipient_user_id, title, body, route)
    VALUES (NEW.id, v_founder, 'New user',
            v_name || ' vient d''arriver sur Patron.', '/(app)/founder-kpi/vendeurs')
    ON CONFLICT (business_id) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN RETURN NEW; END IF;

    -- The alert row above is the durable record; the HTTP call is a
    -- delivery attempt in its own subtransaction, so a pg_net problem can
    -- neither lose the row nor block the business insert.
    BEGIN
      PERFORM net.http_post(
        url     := 'https://jnxpujsyvbenqgjbvifh.supabase.co/functions/v1/dispatch-notification',
        headers := jsonb_build_object(
          'Content-Type',  'application/json',
          'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'patron_cron_secret')
        ),
        body    := jsonb_build_object('business_id', NEW.id, 'event_type', 'founder_new_user', 'payload', '{}'::jsonb),
        timeout_milliseconds := 15000
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'founder_new_user push not sent for %: %', NEW.id, SQLERRM;
    END;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'notify_founder_new_business failed for %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.notify_founder_new_business() FROM PUBLIC, anon, authenticated;

-- Named so it sorts AFTER businesses_inherit_is_test (BEFORE trigger) — and an
-- AFTER trigger always sees the final NEW.is_test anyway.
DROP TRIGGER IF EXISTS businesses_notify_founder ON public.businesses;
CREATE TRIGGER businesses_notify_founder
  AFTER INSERT ON public.businesses
  FOR EACH ROW EXECUTE FUNCTION public.notify_founder_new_business();
