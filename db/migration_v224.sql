-- ============================================================
-- Patron — Migration v224
-- Run in Supabase SQL Editor AFTER migration_v223
--
-- Fix: withdrawals ("Retraits") were append-only and immutable.
-- record_withdrawal() (v115) inserts a NEW negative row for a
-- withdrawal, but there was no way to correct a fat-fingered amount,
-- contributor, note, or date — unlike injections, which have
-- edit_injection(). The only path offered was to record yet another
-- compensating row, which silently corrupts the ledger history.
--
-- This adds edit_withdrawal(): admin/manager-only correction of an
-- EXISTING withdrawal row. It is the mirror of edit_injection() but
-- refuses to touch a positive row (you can't "edit" an injection as a
-- withdrawal) and stores the positive input p_amount as negative,
-- preserving the signed-amount ledger invariant.
--
-- Delete still does not exist — editing fixes the fat-finger pain
-- without needing destructive mutation of the ledger.
-- ============================================================

CREATE OR REPLACE FUNCTION public.edit_withdrawal(
  p_id               uuid,
  p_amount           bigint,          -- cents ×100, positive input — stored as negative
  p_injected_by_id   uuid    DEFAULT NULL,
  p_source_name      text    DEFAULT NULL,
  p_note             text    DEFAULT NULL,
  p_withdrawn_at     date    DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business_id uuid;
  v_amount      bigint;
BEGIN
  SELECT business_id, amount INTO v_business_id, v_amount
  FROM capital_injections WHERE id = p_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Retrait introuvable' USING ERRCODE = 'P0001';
  END IF;

  IF v_amount >= 0 THEN
    RAISE EXCEPTION 'Cette entrée n''est pas un retrait' USING ERRCODE = 'P0001';
  END IF;

  IF get_role(v_business_id) NOT IN ('administrateur', 'manager') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Le montant doit être positif' USING ERRCODE = 'P0001';
  END IF;

  UPDATE capital_injections SET
    amount          = -p_amount,
    injected_by_id  = p_injected_by_id,
    source_name     = nullif(trim(coalesce(p_source_name, '')), ''),
    note            = nullif(trim(coalesce(p_note, '')), ''),
    injected_at     = coalesce(p_withdrawn_at, injected_at),
    edited_at       = now(),
    edited_by       = auth.uid()
  WHERE id = p_id;
END;
$$;

REVOKE ALL ON FUNCTION public.edit_withdrawal(uuid, bigint, uuid, text, text, date) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.edit_withdrawal(uuid, bigint, uuid, text, text, date) TO authenticated;
