-- ============================================================
-- Patron — Migration v73
-- Run in Supabase SQL Editor AFTER migration_v72
--
-- Integrity: move supplier debt payment allocation to the DB.
-- pay_supplier_debt() replaces the client-side FIFO loop in
-- stores/fournisseurs.ts with an atomic DB function that locks
-- rows (FOR UPDATE) before reading balances — two devices
-- paying the same supplier simultaneously now serialize
-- correctly instead of double-paying.
--
-- p_amount_cents is in integer cents (×100), matching all
-- other monetary DB columns.
-- ============================================================

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
  END LOOP;

  RETURN jsonb_build_object('remaining_cents', v_remaining);
END;
$$;

GRANT EXECUTE ON FUNCTION public.pay_supplier_debt(uuid, uuid, bigint) TO authenticated;
