-- ============================================================
-- Patron — Migration v172
-- Run in Supabase SQL Editor AFTER migration_v171
--
-- Fixes a real cash-tracking gap: creating a purchase order and marking it
-- "paid" (fully or partially) at order time never actually deducted that
-- money from cash_on_hand. createCommande() (stores/fournisseurs.ts) only
-- ever wrote a supplier_debts row for the UNPAID remainder — correct, since
-- an unpaid balance is a liability that shouldn't touch cash — but the PAID
-- portion was never written to supplier_payments, the one table
-- get_reports_snapshot/get_period_report's cash_on_hand formula actually
-- subtracts. Money paid to a supplier at order time silently vanished from
-- the books instead of reducing "Argent disponible". One of the app's two
-- "Nouvelle commande" screens (fournisseurs/index.tsx) had no way to even
-- specify a partial amount, so every order from that screen was silently
-- treated as "fully paid, zero cash effect" — the worst version of the bug.
--
-- Fix: create_purchase_order() replaces createCommande's 3-step client-side
-- sequence (PO insert → lines insert → unchecked, error-swallowed debt
-- insert) with one atomic RPC that creates the PO + lines, records a
-- supplier_debts row for any shortfall, AND records a supplier_payments row
-- for whatever was actually paid — same "bundle the money with the
-- mutation" pattern submit_sale already uses. po_id is added (nullable) to
-- both supplier_debts and supplier_payments so every debt/payment can trace
-- back to the order that generated it, which is what makes the new
-- reconciliation check below possible.
-- ============================================================

-- ── 1. Traceability: link debts/payments back to the PO that created them ────
-- ON DELETE SET NULL, not CASCADE — a purchase_orders row disappearing must
-- never silently delete real financial history (a debt/payment record is
-- meaningful on its own regardless of whether the originating PO still
-- exists).

ALTER TABLE public.supplier_debts
  ADD COLUMN IF NOT EXISTS po_id uuid REFERENCES public.purchase_orders(id) ON DELETE SET NULL;

ALTER TABLE public.supplier_payments
  ADD COLUMN IF NOT EXISTS po_id uuid REFERENCES public.purchase_orders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_supplier_debts_po    ON public.supplier_debts(po_id)    WHERE po_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_supplier_payments_po ON public.supplier_payments(po_id) WHERE po_id IS NOT NULL;

-- ── 2. create_purchase_order() — atomic PO + lines + debt + payment ─────────
-- p_lines: jsonb array of {product_id, variant_id, qty, unit_cost} — qty/
-- unit_cost in the SAME raw display-unit convention purchase_orders.total_cost
-- and po_lines.unit_cost already use (numeric(15,2), NOT ×100 cents — these
-- two tables predate the v24 cents migration and were never converted).
-- p_amount_paid is also raw display units, matching p_lines' unit_cost — the
-- function does its own ×100 conversion internally only where it writes to
-- the cents-denominated supplier_debts/supplier_payments tables.

CREATE OR REPLACE FUNCTION public.create_purchase_order(
  p_business_id  uuid,
  p_supplier_id  uuid,
  p_lines        jsonb,
  p_amount_paid  numeric DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_po_id       uuid := gen_random_uuid();
  v_item        jsonb;
  v_total       numeric := 0;
  v_paid        numeric;
  v_owed        numeric;
  v_role        text;
BEGIN
  -- get_role() returns NULL for a caller who isn't a member of p_business_id
  -- at all — and `NULL NOT IN (...)` evaluates to NULL, which plpgsql's IF
  -- treats as false, silently skipping the exception. Explicit NULL guard so
  -- a non-member is rejected outright instead of falling through. See
  -- db/migration_v173.sql for the same class of fix applied to every other
  -- RPC that had this exact gap (submit_sale, cancel_sale, and others —
  -- this bare `get_role(...) NOT IN (...)` pattern with no NULL guard turned
  -- out to be widespread, not new to this function).
  v_role := get_role(p_business_id);
  IF v_role IS NULL OR v_role NOT IN ('administrateur', 'manager') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'La commande doit contenir au moins une ligne' USING ERRCODE = 'P0001';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_total := v_total + (v_item->>'qty')::numeric * (v_item->>'unit_cost')::numeric;
  END LOOP;

  -- Defaults to "fully paid" — same default createCommande's JS always used
  -- (input.amountPaid ?? total) — preserved here so a caller that omits the
  -- param gets identical behavior to before.
  v_paid := COALESCE(p_amount_paid, v_total);
  v_owed := GREATEST(0, v_total - v_paid);

  INSERT INTO purchase_orders (id, business_id, supplier_id, status, ordered_at, total_cost, created_by)
  VALUES (v_po_id, p_business_id, p_supplier_id, 'brouillon', now(), v_total, auth.uid());

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    INSERT INTO po_lines (id, po_id, product_id, variant_id, qty_ordered, qty_received, unit_cost)
    VALUES (
      gen_random_uuid(), v_po_id,
      (v_item->>'product_id')::uuid,
      NULLIF(v_item->>'variant_id', '')::uuid,
      (v_item->>'qty')::numeric, 0,
      (v_item->>'unit_cost')::numeric
    );
  END LOOP;

  -- Unpaid remainder → a liability. Correctly leaves cash alone; only ever
  -- affects cash_on_hand later, when actually paid off via pay_supplier_debt.
  IF v_owed > 0.01 THEN
    INSERT INTO supplier_debts (business_id, supplier_id, po_id, amount, amount_paid, description, date, created_by)
    VALUES (p_business_id, p_supplier_id, v_po_id, ROUND(v_owed * 100)::bigint, 0, NULL, CURRENT_DATE, auth.uid());
  END IF;

  -- Money that actually left the business at order time → a real payment.
  -- This is the fix: previously nothing was ever written here for this case,
  -- so cash_on_hand never reflected it.
  IF v_paid > 0.01 THEN
    INSERT INTO supplier_payments (business_id, supplier_id, po_id, amount_cents, paid_by, note)
    VALUES (p_business_id, p_supplier_id, v_po_id, ROUND(v_paid * 100)::bigint, auth.uid(), 'Paiement à la commande');
  END IF;

  RETURN v_po_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_purchase_order(uuid, uuid, jsonb, numeric) TO authenticated;

-- ── 3. Reconciliation: check 84 — PO total vs. its recorded debt+payment ────
-- Same additive, standalone-function pattern migration_v158/v159.sql
-- established for checks 81-83 (a small single-purpose function inserting
-- into reconciliation_findings, called alongside run_display_checks/
-- run_variant_price_checks — see _shared/reconciliation.ts) rather than
-- reproducing run_display_checks' ~250-line body via CREATE OR REPLACE for
-- one more check.
--
-- Only ever fires for a PO with at least one linked supplier_debts/
-- supplier_payments row — that only happens via create_purchase_order()
-- (this migration), so a legacy PO from before this fix (or a real
-- consignment/free order with nothing owed or paid) has nothing to compare
-- against and is silently skipped, not flagged as a false mismatch.

CREATE OR REPLACE FUNCTION run_supplier_payment_checks(p_run_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN

  -- 84. Purchase order total doesn't match its recorded debt + payment.
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT
    p_run_id, 84, 'Commandes', 'Commande fournisseur : total ≠ dette + paiement enregistrés', 'critical',
    po.business_id, 'purchase_order', po.id,
    format('Commande #%s — total %s centimes ≠ dette+paiement enregistrés %s centimes (écart %s)',
      LEFT(po.id::text, 8), ROUND(po.total_cost * 100), recorded.total_cents,
      ROUND(po.total_cost * 100) - recorded.total_cents),
    1
  FROM purchase_orders po
  JOIN LATERAL (
    SELECT
      COALESCE((SELECT SUM(amount)         FROM supplier_debts    WHERE po_id = po.id), 0)
      + COALESCE((SELECT SUM(amount_cents) FROM supplier_payments WHERE po_id = po.id), 0)
      AS total_cents
  ) recorded ON true
  WHERE recorded.total_cents > 0
    AND ABS(ROUND(po.total_cost * 100) - recorded.total_cents) > 100; -- 1 GNF tolerance (rounding)

END;
$$;

GRANT EXECUTE ON FUNCTION run_supplier_payment_checks(uuid) TO service_role;
