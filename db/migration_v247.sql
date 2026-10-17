-- ============================================================
-- migration_v247 — Founder care plan (J0 → J30) on the Vendeurs screen
--
-- The founder follows a WhatsApp care plan per new vendor: Jour 0, Jour 1,
-- Jour 7, repos, Jour 30. Nothing is ever sent automatically: this only
-- remembers WHICH step the founder already did for WHICH business, and gives
-- the screen the 7-day activity counts the Jour-7 message quotes.
--
--   1. founder_care_contacts — PK (business_id, step). RLS on, no policy,
--      no grant: only the two definer RPCs below can touch it (same posture
--      as founder_outreach_log, v238).
--   2. mark_founder_care_contact(business, step) — idempotent (a second tap
--      changes nothing). Founder guard identical to v238.
--   3. get_founder_care_state() — one row per REAL business (same population
--      as get_founder_vendor_directory: kpi_businesses, so test / demo
--      businesses are excluded server-side), with sales_7d, credits_7d and the
--      contacts already made.
--
-- Sales vs credits: sale_orders.is_credit is the permanent "this was recorded
-- as a credit" flag (v6; set by submit_sale / submit_carnet_debt at creation
-- and kept after the debt is repaid, unlike the mutable status). Counted on
-- the same ledger as the KPI screen: status IN ('paye','credit').
-- ============================================================

CREATE TABLE IF NOT EXISTS public.founder_care_contacts (
  business_id  uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  step         text NOT NULL CHECK (step IN ('j0', 'j1', 'j7', 'repos', 'j30')),
  contacted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, step)
);

ALTER TABLE public.founder_care_contacts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.founder_care_contacts FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.mark_founder_care_contact(p_business_id uuid, p_step text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_at timestamptz;
BEGIN
  IF NOT COALESCE(is_founder(), false) THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;
  IF p_step IS NULL OR p_step NOT IN ('j0', 'j1', 'j7', 'repos', 'j30') THEN
    RAISE EXCEPTION 'Étape invalide' USING ERRCODE = 'P0001';
  END IF;
  IF p_business_id IS NULL OR NOT EXISTS (SELECT 1 FROM businesses WHERE id = p_business_id) THEN
    RAISE EXCEPTION 'Commerce introuvable' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO founder_care_contacts (business_id, step)
  VALUES (p_business_id, p_step)
  ON CONFLICT (business_id, step) DO NOTHING;

  SELECT contacted_at INTO v_at
    FROM founder_care_contacts
   WHERE business_id = p_business_id AND step = p_step;

  RETURN jsonb_build_object('business_id', p_business_id, 'step', p_step, 'contacted_at', v_at);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.mark_founder_care_contact(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_founder_care_contact(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_founder_care_state()
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
    SELECT jsonb_agg(t ORDER BY t.created_at, t.business_id)
      FROM (
        SELECT
          kb.business_id,
          kb.created_at,
          (SELECT count(*) FROM sale_orders so
            WHERE so.business_id = kb.business_id
              AND so.status IN ('paye', 'credit')
              AND NOT COALESCE(so.is_credit, false)
              AND so.created_at >= now() - interval '7 days')::int AS sales_7d,
          (SELECT count(*) FROM sale_orders so
            WHERE so.business_id = kb.business_id
              AND so.status IN ('paye', 'credit')
              AND COALESCE(so.is_credit, false)
              AND so.created_at >= now() - interval '7 days')::int AS credits_7d,
          COALESCE((
            SELECT jsonb_agg(jsonb_build_object('step', c.step, 'contacted_at', c.contacted_at))
              FROM founder_care_contacts c
             WHERE c.business_id = kb.business_id
          ), '[]'::jsonb) AS contacts
        FROM kpi_businesses kb
      ) t
  ), '[]'::jsonb);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_founder_care_state() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_founder_care_state() TO authenticated;
