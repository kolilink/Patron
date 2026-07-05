-- ============================================================
-- Patron — Migration v74
-- Run in Supabase SQL Editor AFTER migration_v73
--
-- Audit trail: add supplier_payments table so every call to
-- pay_supplier_debt creates an immutable payment log row.
-- Only the allocated amount (what was actually applied to debts)
-- is recorded — remaining_cents is NOT stored here.
-- ============================================================

-- ── Table ──────────────────────────────────────────────────────────────────────

CREATE TABLE public.supplier_payments (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid        NOT NULL REFERENCES public.businesses(id)  ON DELETE CASCADE,
  supplier_id  uuid        NOT NULL REFERENCES public.suppliers(id)   ON DELETE CASCADE,
  amount_cents bigint      NOT NULL CHECK (amount_cents > 0),
  paid_by      uuid        NOT NULL REFERENCES auth.users(id),
  paid_at      timestamptz NOT NULL DEFAULT now(),
  note         text
);

-- Most common query: all payments for one supplier, newest first
CREATE INDEX idx_supplier_payments_supplier
  ON public.supplier_payments(business_id, supplier_id, paid_at DESC);

-- ── RLS ────────────────────────────────────────────────────────────────────────

ALTER TABLE public.supplier_payments ENABLE ROW LEVEL SECURITY;

-- Members can read; no direct INSERT (all writes go through the SECURITY DEFINER RPC)
CREATE POLICY "Membres: voir les paiements fournisseurs"
  ON public.supplier_payments FOR SELECT
  USING (is_member(business_id));

-- ── Update pay_supplier_debt to log allocated amount ───────────────────────────

CREATE OR REPLACE FUNCTION public.pay_supplier_debt(
  p_business_id  uuid,
  p_supplier_id  uuid,
  p_amount_cents bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_remaining   bigint := p_amount_cents;
  v_allocated   bigint := 0;
  v_debt        record;
  v_outstanding bigint;
  v_paying      bigint;
BEGIN
  IF get_role(p_business_id) NOT IN ('administrateur', 'manager') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'Le montant doit être positif' USING ERRCODE = 'P0001';
  END IF;

  -- FOR UPDATE locks each debt row before reading its balance,
  -- preventing concurrent double-payment on the same debt.
  FOR v_debt IN
    SELECT id, amount, amount_paid
    FROM supplier_debts
    WHERE business_id = p_business_id
      AND supplier_id = p_supplier_id
      AND amount      > amount_paid
    ORDER BY created_at ASC
    FOR UPDATE
  LOOP
    IF v_remaining <= 0 THEN EXIT; END IF;

    v_outstanding := v_debt.amount - v_debt.amount_paid;
    v_paying      := LEAST(v_remaining, v_outstanding);

    UPDATE supplier_debts
    SET amount_paid = amount_paid + v_paying
    WHERE id = v_debt.id;

    v_remaining := v_remaining - v_paying;
    v_allocated := v_allocated + v_paying;
  END LOOP;

  -- Log only what was actually allocated (not the requested amount)
  IF v_allocated > 0 THEN
    INSERT INTO public.supplier_payments (business_id, supplier_id, amount_cents, paid_by)
    VALUES (p_business_id, p_supplier_id, v_allocated, auth.uid());
  END IF;

  RETURN jsonb_build_object('remaining_cents', v_remaining);
END;
$$;

GRANT EXECUTE ON FUNCTION public.pay_supplier_debt(uuid, uuid, bigint) TO authenticated;
