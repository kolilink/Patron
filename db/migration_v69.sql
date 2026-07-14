-- ============================================================
-- Patron — Migration v69
-- Run in Supabase SQL Editor AFTER migration_v68
--
-- Adds capital injection tracking ("Apports de fonds").
-- An injection is money entering the business that is NOT
-- revenue — it doesn't affect profit/loss but does affect
-- cash position. It can be attributed to a member or a
-- free-text name (silent investor, family member, etc.).
-- ============================================================

-- ─── 1. Table ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS capital_injections (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  amount          bigint      NOT NULL CHECK (amount > 0),   -- cents ×100
  injected_by_id  uuid        REFERENCES profiles(id),       -- NULL = free-text source
  source_name     text,                                       -- free text when no account
  note            text,
  injected_at     date        NOT NULL DEFAULT CURRENT_DATE,
  created_by      uuid        NOT NULL REFERENCES profiles(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE capital_injections ENABLE ROW LEVEL SECURITY;

-- Admin / Manager: full access
CREATE POLICY "Admin/Manager: gérer les apports"
  ON capital_injections FOR ALL TO authenticated
  USING   (get_role(business_id) IN ('administrateur', 'manager'))
  WITH CHECK (get_role(business_id) IN ('administrateur', 'manager'));

-- Investisseur: read only
CREATE POLICY "Investisseur: voir les apports"
  ON capital_injections FOR SELECT TO authenticated
  USING (get_role(business_id) = 'investisseur');

CREATE INDEX IF NOT EXISTS idx_capital_injections_business
  ON capital_injections (business_id, injected_at DESC);

-- ─── 2. RPC: record_injection ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.record_injection(
  p_business_id      uuid,
  p_amount           bigint,          -- cents ×100
  p_injected_by_id   uuid    DEFAULT NULL,
  p_source_name      text    DEFAULT NULL,
  p_note             text    DEFAULT NULL,
  p_injected_at      date    DEFAULT CURRENT_DATE
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF get_role(p_business_id) NOT IN ('administrateur', 'manager') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Le montant doit être positif' USING ERRCODE = 'P0001';
  END IF;

  v_id := gen_random_uuid();

  INSERT INTO capital_injections (
    id, business_id, amount,
    injected_by_id, source_name, note,
    injected_at, created_by
  ) VALUES (
    v_id, p_business_id, p_amount,
    p_injected_by_id,
    nullif(trim(coalesce(p_source_name, '')), ''),
    nullif(trim(coalesce(p_note, '')), ''),
    p_injected_at,
    auth.uid()
  );

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_injection(uuid, bigint, uuid, text, text, date) TO authenticated;
