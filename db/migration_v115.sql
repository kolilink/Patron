-- ============================================================
-- Patron — Migration v115
-- Run in Supabase SQL Editor AFTER migration_v114
--
-- Capital injections ("Apports"): allow admin/manager to correct
-- a mistaken entry, and allow recording that previously-contributed
-- capital was taken back out.
--
--   1. capital_injections gets edited_at / edited_by (audit trail)
--      and the CHECK constraint relaxes from amount > 0 to != 0
--      so a withdrawal can be stored as a negative amount.
--   2. edit_injection()      — admin/manager RPC: correct amount,
--                              contributor, note, or date of an
--                              existing row. Logs edited_at/edited_by.
--   3. record_withdrawal()   — admin/manager RPC: inserts a NEW
--                              negative-amount row representing
--                              capital taken back out. This is an
--                              append-only reversal (like the rest
--                              of the ledger), not a mutation of
--                              past rows, so history + reconciliation
--                              stay intact.
--
-- Neither of these is reachable by vendeur or investisseur — same
-- role gate as record_injection (admin/manager only).
-- ============================================================

-- ─── 1. Schema changes ────────────────────────────────────────────────────────

ALTER TABLE capital_injections
  ADD COLUMN IF NOT EXISTS edited_at timestamptz,
  ADD COLUMN IF NOT EXISTS edited_by uuid REFERENCES profiles(id);

ALTER TABLE capital_injections DROP CONSTRAINT IF EXISTS capital_injections_amount_check;
ALTER TABLE capital_injections ADD CONSTRAINT capital_injections_amount_check CHECK (amount <> 0);

-- ─── 2. edit_injection ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.edit_injection(
  p_id               uuid,
  p_amount           bigint,          -- cents ×100, must be > 0 (edits never target a withdrawal row)
  p_injected_by_id   uuid    DEFAULT NULL,
  p_source_name      text    DEFAULT NULL,
  p_note             text    DEFAULT NULL,
  p_injected_at      date    DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business_id uuid;
BEGIN
  SELECT business_id INTO v_business_id FROM capital_injections WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Apport introuvable' USING ERRCODE = 'P0001';
  END IF;

  IF get_role(v_business_id) NOT IN ('administrateur', 'manager') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Le montant doit être positif' USING ERRCODE = 'P0001';
  END IF;

  UPDATE capital_injections SET
    amount          = p_amount,
    injected_by_id  = p_injected_by_id,
    source_name     = nullif(trim(coalesce(p_source_name, '')), ''),
    note            = nullif(trim(coalesce(p_note, '')), ''),
    injected_at     = coalesce(p_injected_at, injected_at),
    edited_at       = now(),
    edited_by       = auth.uid()
  WHERE id = p_id;
END;
$$;

REVOKE ALL ON FUNCTION public.edit_injection(uuid, bigint, uuid, text, text, date) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.edit_injection(uuid, bigint, uuid, text, text, date) TO authenticated;

-- ─── 3. record_withdrawal ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.record_withdrawal(
  p_business_id      uuid,
  p_amount           bigint,          -- cents ×100, positive input — stored as negative
  p_injected_by_id   uuid    DEFAULT NULL,
  p_source_name      text    DEFAULT NULL,
  p_note             text    DEFAULT NULL,
  p_withdrawn_at     date    DEFAULT CURRENT_DATE
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
    v_id, p_business_id, -p_amount,
    p_injected_by_id,
    nullif(trim(coalesce(p_source_name, '')), ''),
    nullif(trim(coalesce(p_note, '')), ''),
    p_withdrawn_at,
    auth.uid()
  );

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_withdrawal(uuid, bigint, uuid, text, text, date) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_withdrawal(uuid, bigint, uuid, text, text, date) TO authenticated;
