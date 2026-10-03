-- ============================================================
-- Patron — Migration v215
-- Run in Supabase SQL Editor AFTER migration_v214
--
-- "E2E FIX BATCH A — money-critical". Seven fixes across DB functions,
-- policies and one schema addition. TEST DB only — do not commit.
--
--   1. P0 — cancel_sale never reversed investor_balance. Every cancelled
--      sale left phantom profit in investor_balance, paid out as real cash.
--      Fix: on cancel, reverse the accrual using submit_sale's exact formula
--      (per-line GREATEST(0,(unit_price-cost)×qty) × profit_share/100 for
--      investors with a scope row on that product and profit_share > 0).
--
--   2. P0 — zero-admin via DELETE was still open. v212 blocks the UPDATE
--      vectors; v51's DELETE policy only blocked a sole admin deleting
--      THEIR OWN row. A manager could still DELETE the sole admin's row.
--      Fix: extend last-admin protection to any admin deletion when only one
--      admin exists.
--
--   3. P0 — payout TOCTOU. request_payout/confirm_payout did
--      SELECT-then-UPDATE with no row lock, so concurrent confirms could
--      double-deduct the investor's balance. Fix: SELECT … FOR UPDATE on the
--      payout and investor_balance rows in both functions.
--
--   4. P1 — submit_sale had no discount guard. A discount ≥ total stored a
--      negative-owed debt shown as «Réglé ✓». Fix: server-side guards
--      (discount ≥ 0, and discount > 0 ⇒ discount < total), mirroring
--      edit_sale's 'La remise doit être inférieure au total'.
--
--   5. P1 — checkout overpay inflated the sale total. Fix: submit_sale
--      rejects any payment amount exceeding the remaining balance owed
--      ('Le montant dépasse le solde restant dû'). The client change is in
--      app/(app)/(tabs)/vendre.tsx (same commit set).
--
--   6. P1 — amount-0 pay-step + default «rabais» recorded paid-in-full with
--      zero paid. Server-side, a zero-amount payment is already ignored by
--      submit_sale's payment insert (p_pay_amount > 0). The discount guard
--      above now blocks the silent 100% discount vector; the client change
--      (same commit set) blocks the amount-0 rabais at the UI.
--
--   7. P1 — void_payment let any vendeur void anyone's payment, and could
--      resurrect a cancelled sale. Fix: vendeurs may only void their own
--      payments (payments.seller_id = auth.uid(); admin/manager exempt),
--      and voiding a payment on an 'annule' sale is rejected.
--
-- payments.seller_id is new (recording user at insert time, backfilled from
-- the parent sale's seller_id where available).
-- ============================================================

-- ------------------------------------------------------------------
-- 0. payments.seller_id — recording user, for fix #7 ownership checks
-- ------------------------------------------------------------------
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS seller_id uuid REFERENCES auth.users(id);

UPDATE payments p
SET seller_id = so.seller_id
FROM sale_orders so
WHERE so.id = p.order_id
  AND p.seller_id IS NULL;

-- ------------------------------------------------------------------
-- 1. submit_sale — discount guard + overpay guard + seller_id
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_sale(
  p_business_id      uuid,
  p_seller_id        uuid,
  p_customer_name    text      DEFAULT NULL,
  p_sale_date        date      DEFAULT CURRENT_DATE,
  p_total_amount     numeric   DEFAULT 0,
  p_discount_amount  numeric   DEFAULT 0,
  p_is_credit        boolean   DEFAULT false,
  p_cart             jsonb     DEFAULT '[]',
  p_pay_method       text      DEFAULT NULL,
  p_pay_amount       numeric   DEFAULT NULL,
  p_pay_ref          text      DEFAULT NULL,
  p_idempotency_key  uuid      DEFAULT NULL,
  p_client_id        uuid      DEFAULT NULL,
  p_due_date         date      DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order_id       uuid;
  v_item           jsonb;
  v_membership_id  uuid;
  v_has_scope      boolean;
  v_cost_price     bigint;
  v_unit_price_eff bigint;
  v_line_profit    bigint;
  v_investor       RECORD;
  v_rows_affected  integer;
  v_computed_total bigint;
BEGIN
  IF get_role(p_business_id) IS NULL OR get_role(p_business_id) NOT IN ('administrateur', 'manager', 'vendeur') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF get_role(p_business_id) = 'vendeur' AND p_seller_id != auth.uid() THEN
    RAISE EXCEPTION 'Un vendeur ne peut enregistrer que ses propres ventes' USING ERRCODE = 'P0001';
  END IF;

  IF get_role(p_business_id) = 'vendeur' THEN
    SELECT id INTO v_membership_id
    FROM memberships
    WHERE user_id = auth.uid() AND business_id = p_business_id;

    SELECT EXISTS(
      SELECT 1 FROM membership_product_scope WHERE membership_id = v_membership_id
    ) INTO v_has_scope;

    IF v_has_scope THEN
      PERFORM 1
      FROM jsonb_to_recordset(p_cart) AS c(product_id uuid)
      WHERE c.product_id NOT IN (
        SELECT product_id FROM membership_product_scope
        WHERE membership_id = v_membership_id
      );
      IF FOUND THEN
        RAISE EXCEPTION 'Produit non autorisé : ce vendeur ne peut pas vendre ce produit' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_order_id
    FROM sale_orders
    WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN RETURN v_order_id; END IF;
  END IF;

  -- Validate the whole cart BEFORE inserting anything — fail fast, nothing
  -- to roll back. Every qty must be a real positive number, and every
  -- product/variant must actually belong to this business (SECURITY
  -- DEFINER means RLS never enforces this on its own — see migration note).
  IF p_cart IS NULL OR jsonb_array_length(p_cart) = 0 THEN
    RAISE EXCEPTION 'Ajoutez au moins un article' USING ERRCODE = 'P0001';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_cart) LOOP
    IF (v_item->>'qty')::numeric IS NULL OR (v_item->>'qty')::numeric <= 0 THEN
      RAISE EXCEPTION 'Quantité invalide pour "%"', coalesce(v_item->>'product_name', 'un article')
        USING ERRCODE = 'P0001';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM products
      WHERE id = (v_item->>'product_id')::uuid AND business_id = p_business_id
    ) THEN
      RAISE EXCEPTION 'Produit introuvable' USING ERRCODE = 'P0001';
    END IF;

    IF nullif(v_item->>'variant_id', '') IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM product_variants
      WHERE id = nullif(v_item->>'variant_id', '')::uuid AND business_id = p_business_id
    ) THEN
      RAISE EXCEPTION 'Produit introuvable' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  v_order_id := gen_random_uuid();

  -- Never trust the client's own total: derive it from the same cart it
  -- also supplies, before that cart's lines are even inserted. Line-level
  -- unit_price stays fully trusted (negotiated pricing is intentional) —
  -- only the AGGREGATE total is no longer a separately-asserted number.
  SELECT COALESCE(SUM((item->>'qty')::numeric * (item->>'unit_price')::numeric), 0)::bigint
  INTO v_computed_total
  FROM jsonb_array_elements(p_cart) AS item;

  -- Fix #4 — discount guard, mirroring edit_sale's semantics. A negative
  -- discount is nonsense; a discount ≥ total would store a negative-owed
  -- debt shown as «Réglé ✓».
  IF COALESCE(p_discount_amount, 0) < 0 THEN
    RAISE EXCEPTION 'La remise ne peut pas être négative' USING ERRCODE = 'P0001';
  END IF;
  IF COALESCE(p_discount_amount, 0) > 0 AND COALESCE(p_discount_amount, 0) >= v_computed_total THEN
    RAISE EXCEPTION 'La remise doit être inférieure au total' USING ERRCODE = 'P0001';
  END IF;

  -- Fix #5 — overpay guard. Never let a payment exceed the remaining
  -- balance owed (total − discount).
  IF p_pay_amount IS NOT NULL
     AND p_pay_amount > (v_computed_total - COALESCE(p_discount_amount, 0)) THEN
    RAISE EXCEPTION 'Le montant dépasse le solde restant dû' USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    INSERT INTO sale_orders (
      id, business_id, seller_id, customer_name, client_id,
      status, is_credit, paid_at, sale_date, due_date,
      total_amount, discount_amount, created_by, idempotency_key
    ) VALUES (
      v_order_id, p_business_id, p_seller_id,
      nullif(trim(coalesce(p_customer_name, '')), ''),
      p_client_id,
      CASE WHEN p_is_credit THEN 'credit' ELSE 'paye' END,
      p_is_credit,
      CASE WHEN NOT p_is_credit THEN now() ELSE NULL END,
      p_sale_date,
      CASE WHEN p_is_credit THEN p_due_date ELSE NULL END,
      v_computed_total, p_discount_amount,
      auth.uid(), p_idempotency_key
    );
  EXCEPTION WHEN unique_violation THEN
    -- Race: another concurrent request with the same key committed first.
    -- Return its order ID so the client gets an idempotent response instead
    -- of a raw duplicate-key error.
    IF p_idempotency_key IS NOT NULL THEN
      SELECT id INTO v_order_id
      FROM sale_orders
      WHERE idempotency_key = p_idempotency_key;
      IF FOUND THEN RETURN v_order_id; END IF;
    END IF;
    RAISE;
  END;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_cart) LOOP
    -- Cost snapshot: variant first, fall back to parent product. business_id
    -- filter is defense-in-depth — the validation pass above already
    -- guarantees ownership, this just means a future edit that weakens that
    -- pass can't silently reopen cross-business cost_price exposure either.
    v_cost_price := NULL;
    IF nullif(v_item->>'variant_id', '') IS NOT NULL THEN
      SELECT cost_price INTO v_cost_price
      FROM product_variants
      WHERE id = nullif(v_item->>'variant_id', '')::uuid AND business_id = p_business_id;
    END IF;
    IF v_cost_price IS NULL THEN
      SELECT cost_price INTO v_cost_price
      FROM products
      WHERE id = (v_item->>'product_id')::uuid AND business_id = p_business_id;
    END IF;

    INSERT INTO so_lines (
      id, order_id, product_id, product_name,
      qty, unit_price, is_bulk,
      variant_id, variant_name,
      cost_price_at_sale
    ) VALUES (
      gen_random_uuid(), v_order_id,
      (v_item->>'product_id')::uuid,
      v_item->>'product_name',
      (v_item->>'qty')::numeric,
      (v_item->>'unit_price')::numeric,
      coalesce((v_item->>'is_bulk')::boolean, false),
      nullif(v_item->>'variant_id', '')::uuid,
      nullif(v_item->>'variant_name', ''),
      v_cost_price
    );
  END LOOP;

  IF p_pay_method IS NOT NULL AND p_pay_amount IS NOT NULL AND p_pay_amount > 0 THEN
    INSERT INTO payments (id, order_id, customer_name, business_id, method, amount, date, ref_external, seller_id)
    VALUES (
      gen_random_uuid(), v_order_id,
      nullif(trim(coalesce(p_customer_name, '')), ''),
      p_business_id, p_pay_method, p_pay_amount, p_sale_date,
      nullif(trim(coalesce(p_pay_ref, '')), ''),
      auth.uid()
    );
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_cart) LOOP
    INSERT INTO stock_moves (
      id, business_id, product_id, type, qty, ref_id, ref_type, note, created_by
    ) VALUES (
      gen_random_uuid(), p_business_id,
      (v_item->>'product_id')::uuid,
      'sortie',
      (v_item->>'qty')::numeric,
      v_order_id, 'sale_order', NULL, auth.uid()
    );

    IF nullif(v_item->>'variant_id', '') IS NOT NULL THEN
      -- Variant product: guard is on product_variants (parent products.stock_qty
      -- is always 0 for variant parents so no meaningful guard there).
      -- business_id filter is defense-in-depth (see note above).
      UPDATE products
      SET stock_qty = GREATEST(0, stock_qty - (v_item->>'qty')::numeric)
      WHERE id = (v_item->>'product_id')::uuid AND business_id = p_business_id;

      UPDATE product_variants
      SET stock_qty = stock_qty - (v_item->>'qty')::numeric
      WHERE id     = nullif(v_item->>'variant_id', '')::uuid
        AND business_id = p_business_id
        AND stock_qty >= (v_item->>'qty')::numeric;

      GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
      IF v_rows_affected = 0 THEN
        RAISE EXCEPTION 'Stock insuffisant : %',
          coalesce(nullif(v_item->>'variant_name', ''), v_item->>'product_name', 'Produit inconnu')
          USING ERRCODE = 'P0001';
      END IF;
    ELSE
      -- Plain product: guard is on products. business_id filter is
      -- defense-in-depth (see note above).
      UPDATE products
      SET stock_qty = stock_qty - (v_item->>'qty')::numeric
      WHERE id      = (v_item->>'product_id')::uuid
        AND business_id = p_business_id
        AND stock_qty >= (v_item->>'qty')::numeric;

      GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
      IF v_rows_affected = 0 THEN
        RAISE EXCEPTION 'Stock insuffisant : %',
          coalesce(v_item->>'product_name', 'Produit inconnu')
          USING ERRCODE = 'P0001';
      END IF;
    END IF;

    -- Investor profit accumulation: unit_price is now always the real price
    -- charged. business_id filter is defense-in-depth (see note above).
    v_cost_price := NULL;
    IF nullif(v_item->>'variant_id', '') IS NOT NULL THEN
      SELECT cost_price INTO v_cost_price
      FROM product_variants
      WHERE id = nullif(v_item->>'variant_id', '')::uuid AND business_id = p_business_id;
    END IF;
    IF v_cost_price IS NULL THEN
      SELECT cost_price INTO v_cost_price
      FROM products
      WHERE id = (v_item->>'product_id')::uuid AND business_id = p_business_id;
    END IF;

    v_unit_price_eff := (v_item->>'unit_price')::bigint;

    v_line_profit := GREATEST(0,
      (v_unit_price_eff - coalesce(v_cost_price, 0))
      * (v_item->>'qty')::bigint
    );

    IF v_line_profit > 0 THEN
      FOR v_investor IN
        SELECT m.user_id, mps.profit_share
        FROM membership_product_scope mps
        JOIN memberships m ON m.id = mps.membership_id
        WHERE mps.product_id  = (v_item->>'product_id')::uuid
          AND m.business_id   = p_business_id
          AND m.role          = 'investisseur'
          AND mps.profit_share > 0
      LOOP
        INSERT INTO investor_balance (business_id, investor_id, balance, updated_at)
        VALUES (
          p_business_id,
          v_investor.user_id,
          ROUND(v_line_profit * v_investor.profit_share / 100.0)::bigint,
          now()
        )
        ON CONFLICT (business_id, investor_id) DO UPDATE
          SET balance    = investor_balance.balance
                         + ROUND(v_line_profit * v_investor.profit_share / 100.0)::bigint,
              updated_at = now();
      END LOOP;
    END IF;
  END LOOP;

  RETURN v_order_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_sale(uuid, uuid, text, date, numeric, numeric, boolean, jsonb, text, numeric, text, uuid, uuid, date) TO authenticated;

-- ------------------------------------------------------------------
-- 2. cancel_sale — reverse investor_balance on cancel (fix #1)
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_sale(
  p_sale_id     uuid,
  p_business_id uuid,
  p_reason      text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sale        record;
  v_sale_id     uuid;
  v_line        record;
  v_line_profit bigint;
  v_investor    record;
BEGIN
  IF get_role(p_business_id) NOT IN ('administrateur', 'manager', 'vendeur') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  -- Two-step resolution (see migration_v211 header): p_sale_id may be the
  -- real row id OR the idempotency_key of a queued sale that was projected
  -- into the pending overlay before drain.
  SELECT id INTO v_sale_id
  FROM sale_orders
  WHERE id = p_sale_id AND business_id = p_business_id;

  IF v_sale_id IS NULL THEN
    SELECT id INTO v_sale_id
    FROM sale_orders
    WHERE idempotency_key = p_sale_id AND business_id = p_business_id;
  END IF;

  IF v_sale_id IS NULL THEN
    RAISE EXCEPTION 'Vente introuvable' USING ERRCODE = 'P0001';
  END IF;

  SELECT id, seller_id, status INTO v_sale
  FROM sale_orders
  WHERE id = v_sale_id AND business_id = p_business_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vente introuvable' USING ERRCODE = 'P0001';
  END IF;

  -- Idempotent: already cancelled — return without touching anything again.
  IF v_sale.status = 'annule' THEN
    RETURN true;
  END IF;

  IF get_role(p_business_id) = 'vendeur' AND v_sale.seller_id != auth.uid() THEN
    RAISE EXCEPTION 'Un vendeur ne peut annuler que ses propres ventes' USING ERRCODE = 'P0001';
  END IF;

  -- Mark the sale as cancelled.
  UPDATE sale_orders
  SET status              = 'annule',
      cancelled_at        = now(),
      cancellation_reason = p_reason,
      cancelled_by_id     = auth.uid()
  WHERE id = v_sale_id;

  -- Delete payments created by submit_sale for this order.
  DELETE FROM payments WHERE order_id = v_sale_id;

  -- Restore stock for every line item.
  BEGIN
    FOR v_line IN
      SELECT product_id, variant_id, qty
      FROM so_lines
      WHERE order_id = v_sale_id
    LOOP
      INSERT INTO stock_moves (
        id, business_id, product_id, type, qty, ref_id, ref_type, note, created_by
      ) VALUES (
        gen_random_uuid(), p_business_id, v_line.product_id,
        'entree', v_line.qty, v_sale_id, 'annulation',
        'Annulation: ' || coalesce(p_reason, ''), auth.uid()
      );

      IF v_line.variant_id IS NOT NULL THEN
        -- Variant product: parent products.stock_qty is always 0 for
        -- variant parents (see submit_sale) — only the variant row moves.
        -- Defense-in-depth (kept from migration_v196): scope the restore
        -- by business so a so_lines row pointing at another business's
        -- variant can never move that variant's stock.
        UPDATE product_variants
        SET stock_qty = stock_qty + v_line.qty
        WHERE id = v_line.variant_id AND business_id = p_business_id;
      ELSE
        -- Defense-in-depth (kept from migration_v196): a so_lines row
        -- pointing at another business's product must not restore stock
        -- onto it.
        UPDATE products
        SET stock_qty = stock_qty + v_line.qty
        WHERE id = v_line.product_id AND business_id = p_business_id;
      END IF;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    NULL; -- stock restore is best-effort; cancellation itself is committed
  END;

  -- Fix #1 — reverse investor profit accrual, using submit_sale's exact
  -- formula so the two are symmetric: per line, GREATEST(0, (unit_price −
  -- cost) × qty) × profit_share/100 for every investor with a scope row on
  -- that product and profit_share > 0. Uses GREATEST(0, balance − …) so a
  -- CHECK (balance >= 0) violation can never occur and a re-cancel on an
  -- already-reversed sale is a harmless no-op. Deliberately OUTSIDE the
  -- best-effort stock-restore block above: the money side must not be
  -- swallowed by a stock error.
  FOR v_line IN
    SELECT product_id, qty, unit_price, cost_price_at_sale
    FROM so_lines
    WHERE order_id = v_sale_id
  LOOP
    v_line_profit := GREATEST(0,
      ((v_line.unit_price)::bigint - COALESCE(v_line.cost_price_at_sale, 0))
      * (v_line.qty)::bigint
    );

    IF v_line_profit > 0 THEN
      FOR v_investor IN
        SELECT m.user_id, mps.profit_share
        FROM membership_product_scope mps
        JOIN memberships m ON m.id = mps.membership_id
        WHERE mps.product_id  = v_line.product_id
          AND m.business_id   = p_business_id
          AND m.role          = 'investisseur'
          AND mps.profit_share > 0
      LOOP
        UPDATE investor_balance
        SET balance    = GREATEST(0, balance - ROUND(v_line_profit * v_investor.profit_share / 100.0)::bigint),
            updated_at = now()
        WHERE business_id = p_business_id
          AND investor_id  = v_investor.user_id;
      END LOOP;
    END IF;
  END LOOP;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_sale(uuid, uuid, text) TO authenticated;

-- ------------------------------------------------------------------
-- 3. request_payout / confirm_payout — row locks (fix #3)
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.request_payout(
  p_business_id uuid,
  p_amount      bigint
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance    bigint;
  v_payout_id  uuid;
BEGIN
  -- Must be an investor in this business
  IF get_role(p_business_id) IS NULL OR get_role(p_business_id) != 'investisseur' THEN
    RAISE EXCEPTION 'Seuls les investisseurs peuvent faire une demande de retrait' USING ERRCODE = 'P0001';
  END IF;

  -- Fix #3 — lock the balance row so a concurrent request/confirm that
  -- changes it must wait, then re-read the up-to-date balance instead of
  -- the value cached at statement start.
  SELECT balance INTO v_balance
  FROM investor_balance
  WHERE business_id = p_business_id AND investor_id = auth.uid()
  FOR UPDATE;

  IF v_balance IS NULL OR v_balance = 0 THEN
    RAISE EXCEPTION 'Vous n''avez pas de solde disponible' USING ERRCODE = 'P0001';
  END IF;

  IF p_amount > v_balance THEN
    RAISE EXCEPTION 'Le montant demandé dépasse votre solde disponible' USING ERRCODE = 'P0001';
  END IF;

  -- Only one pending request at a time
  IF EXISTS (
    SELECT 1 FROM investor_payouts
    WHERE business_id = p_business_id
      AND investor_id = auth.uid()
      AND status = 'en_attente'
  ) THEN
    RAISE EXCEPTION 'Vous avez déjà une demande en attente' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO investor_payouts (business_id, investor_id, requested_amount)
  VALUES (p_business_id, auth.uid(), p_amount)
  RETURNING id INTO v_payout_id;

  RETURN v_payout_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.confirm_payout(
  p_payout_id   uuid,
  p_paid_amount bigint
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payout investor_payouts%ROWTYPE;
BEGIN
  -- Fix #3 — lock the payout row: concurrent confirms of the same payout
  -- serialize here, and the second one re-reads status = 'paye' and raises
  -- below instead of double-deducting.
  SELECT * INTO v_payout FROM investor_payouts WHERE id = p_payout_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Demande introuvable' USING ERRCODE = 'P0001';
  END IF;

  IF get_role(v_payout.business_id) IS NULL OR get_role(v_payout.business_id) NOT IN ('administrateur', 'manager') THEN
    RAISE EXCEPTION 'Action non autorisée' USING ERRCODE = 'P0001';
  END IF;

  IF v_payout.status != 'en_attente' THEN
    RAISE EXCEPTION 'Cette demande a déjà été traitée' USING ERRCODE = 'P0001';
  END IF;

  IF p_paid_amount > v_payout.requested_amount THEN
    RAISE EXCEPTION 'Le montant payé ne peut pas dépasser le montant demandé' USING ERRCODE = 'P0001';
  END IF;

  -- Defense-in-depth: also lock the balance row so a concurrent payout
  -- request can't interleave between our read and our deduct.
  PERFORM 1
  FROM investor_balance
  WHERE business_id = v_payout.business_id
    AND investor_id  = v_payout.investor_id
  FOR UPDATE;

  UPDATE investor_payouts
  SET paid_amount = p_paid_amount,
      status      = 'paye',
      paid_at     = now(),
      paid_by     = auth.uid()
  WHERE id = p_payout_id;

  -- Deduct from balance (floor at 0 to guard against any race)
  UPDATE investor_balance
  SET balance    = GREATEST(0, balance - p_paid_amount),
      updated_at = now()
  WHERE business_id = v_payout.business_id
    AND investor_id  = v_payout.investor_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.request_payout(uuid, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_payout(uuid, bigint) TO authenticated;

-- ------------------------------------------------------------------
-- 4. void_payment — own-payment check + cancelled-sale guard (fix #7)
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION void_payment(
  p_payment_id  uuid,
  p_business_id uuid,
  p_reason      text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payment    record;
  v_sale       record;
  v_owed       numeric;
  v_still_paid numeric;
BEGIN
  IF get_role(p_business_id) NOT IN ('administrateur', 'manager', 'vendeur') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_payment
  FROM payments
  WHERE id = p_payment_id AND business_id = p_business_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Paiement introuvable' USING ERRCODE = 'P0001';
  END IF;

  -- Idempotent guard: never double-reverse. A retry (offline replay, a
  -- second Annuler tap racing the first) must be a clean no-op error, not
  -- a second compensating row.
  IF v_payment.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'Ce paiement a déjà été annulé' USING ERRCODE = 'P0001';
  END IF;
  IF v_payment.amount < 0 THEN
    RAISE EXCEPTION 'Impossible d''annuler une annulation' USING ERRCODE = 'P0001';
  END IF;

  -- Fix #7 — a vendeur may only void their OWN payments (the recording
  -- user). Admin/manager are exempt.
  IF get_role(p_business_id) = 'vendeur' AND v_payment.seller_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Un vendeur ne peut annuler que ses propres paiements' USING ERRCODE = 'P0001';
  END IF;

  -- Fix #7 — never resurrect a cancelled sale. Lock + read the parent sale
  -- BEFORE voiding, and reject outright if it's already 'annule'.
  IF v_payment.order_id IS NOT NULL THEN
    SELECT id, status, total_amount, discount_amount INTO v_sale
    FROM sale_orders WHERE id = v_payment.order_id FOR UPDATE;

    IF FOUND AND v_sale.status = 'annule' THEN
      RAISE EXCEPTION 'Impossible d''annuler un paiement sur une vente annulée' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE payments
     SET voided_at = now(), voided_by = auth.uid(), void_reason = p_reason
   WHERE id = p_payment_id;

  INSERT INTO payments (id, order_id, customer_name, business_id, method, amount, date, reversal_of, seller_id)
  VALUES (
    gen_random_uuid(), v_payment.order_id, v_payment.customer_name,
    p_business_id, v_payment.method, -v_payment.amount, CURRENT_DATE, p_payment_id,
    auth.uid()
  );

  -- Reopen the parent sale if this reversal drops it below fully-paid.
  IF v_payment.order_id IS NOT NULL AND v_sale.id IS NOT NULL THEN
    v_owed := v_sale.total_amount - COALESCE(v_sale.discount_amount, 0);
    SELECT COALESCE(SUM(amount), 0) INTO v_still_paid
    FROM payments WHERE order_id = v_sale.id AND voided_at IS NULL;

    IF v_still_paid < v_owed - 1 THEN
      UPDATE sale_orders SET status = 'credit', paid_at = NULL WHERE id = v_sale.id;
    END IF;
  END IF;

  RETURN jsonb_build_object('order_id', v_payment.order_id, 'amount', v_payment.amount);
END;
$$;

GRANT EXECUTE ON FUNCTION void_payment(uuid, uuid, text) TO authenticated;

-- ------------------------------------------------------------------
-- 5. record_payment — seller_id on the payment insert
-- ------------------------------------------------------------------
DROP FUNCTION IF EXISTS record_payment(uuid, uuid, numeric, text, date);

CREATE OR REPLACE FUNCTION public.record_payment(
  p_sale_id          uuid,
  p_business_id      uuid,
  p_amount           numeric,
  p_method           text,
  p_date             date,
  p_idempotency_key  uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sale       record;
  v_sale_id    uuid;
  v_already    numeric;
  v_owed       numeric;
  v_fully_paid boolean;
  v_payment_id uuid;
BEGIN
  IF get_role(p_business_id) NOT IN ('administrateur', 'manager', 'vendeur') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Montant invalide' USING ERRCODE = 'P0001';
  END IF;

  -- Two-step resolution: p_sale_id may be the real sale_orders.id OR the
  -- idempotency_key a queued submit_quick_sale/submit_carnet_debt/
  -- submit_sale projected as its local id before drain. Resolve to the
  -- real row id once and use it everywhere downstream.
  SELECT id INTO v_sale_id
  FROM sale_orders
  WHERE id = p_sale_id AND business_id = p_business_id;

  IF v_sale_id IS NULL THEN
    SELECT id INTO v_sale_id
    FROM sale_orders
    WHERE idempotency_key = p_sale_id AND business_id = p_business_id;
  END IF;

  IF v_sale_id IS NULL THEN
    RAISE EXCEPTION 'Vente introuvable' USING ERRCODE = 'P0001';
  END IF;

  -- Idempotency: if this exact call already committed (a queued outbox
  -- item replaying after the original call actually succeeded but the
  -- client never heard back), don't insert a second payment — just
  -- report the sale's current paid state.
  IF p_idempotency_key IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM payments WHERE idempotency_key = p_idempotency_key) THEN
      SELECT id INTO v_payment_id
      FROM payments
      WHERE idempotency_key = p_idempotency_key;

      SELECT status = 'paye' INTO v_fully_paid
      FROM sale_orders
      WHERE id = v_sale_id AND business_id = p_business_id;

      RETURN jsonb_build_object('fully_paid', COALESCE(v_fully_paid, false), 'payment_id', v_payment_id);
    END IF;
  END IF;

  -- Locks the sale row so a racing payment attempt (a second offline queue
  -- replaying against the same debt, a retry, etc.) waits for this one to
  -- commit, then re-reads the up-to-date balance instead of working off
  -- whatever the phone last had cached.
  SELECT id, total_amount, discount_amount, customer_name
  INTO v_sale
  FROM sale_orders
  WHERE id = v_sale_id AND business_id = p_business_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vente introuvable' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_already
  FROM payments WHERE order_id = v_sale_id;

  v_owed := v_sale.total_amount - COALESCE(v_sale.discount_amount, 0);

  -- 1-unit tolerance for floating-point carry-over, matching record_client_payment.
  IF v_already + p_amount > v_owed + 1 THEN
    RAISE EXCEPTION 'Le montant dépasse le solde restant dû' USING ERRCODE = 'P0001';
  END IF;

  v_payment_id := gen_random_uuid();

  BEGIN
    INSERT INTO payments (id, order_id, customer_name, business_id, method, amount, date, idempotency_key, seller_id)
    VALUES (
      v_payment_id, v_sale_id, v_sale.customer_name,
      p_business_id, p_method, p_amount, p_date, p_idempotency_key,
      auth.uid()
    );
  EXCEPTION WHEN unique_violation THEN
    -- A concurrent call with the same key won the race between our
    -- existence check above and this insert — resolve exactly like the
    -- pre-check branch above, never insert a second row.
    SELECT id INTO v_payment_id
    FROM payments
    WHERE idempotency_key = p_idempotency_key;

    SELECT status = 'paye' INTO v_fully_paid
    FROM sale_orders
    WHERE id = v_sale_id AND business_id = p_business_id;
    RETURN jsonb_build_object('fully_paid', COALESCE(v_fully_paid, false), 'payment_id', v_payment_id);
  END;

  v_fully_paid := (v_already + p_amount) >= v_owed - 1;

  IF v_fully_paid THEN
    UPDATE sale_orders SET status = 'paye', paid_at = now() WHERE id = v_sale_id;
  END IF;

  RETURN jsonb_build_object('fully_paid', v_fully_paid, 'payment_id', v_payment_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_payment(uuid, uuid, numeric, text, date, uuid) TO authenticated;

-- ------------------------------------------------------------------
-- 6. record_client_payment — seller_id on the payment insert
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_client_payment(
  p_business_id      uuid,
  p_customer_name    text,
  p_amount           numeric,
  p_method           text,
  p_date             date,
  p_idempotency_key  uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_remaining     numeric := p_amount;
  v_sale          record;
  v_outstanding   numeric;
  v_allocated     numeric;
  v_new_paid      numeric;
  v_fully_settled boolean;
  v_already_claimed boolean := false;
  v_payment_id    uuid;
  v_payment_ids   uuid[] := '{}';
BEGIN
  IF get_role(p_business_id) IS NULL OR get_role(p_business_id) NOT IN ('administrateur', 'manager', 'vendeur') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  -- Claim the idempotency key BEFORE doing any allocation work — this is
  -- what makes "exactly once" true regardless of how many payments rows
  -- the loop below ends up creating. A caller with no key (p_idempotency_key
  -- IS NULL) always proceeds — same "opt-in, backward compatible" posture
  -- migration_v26's sale_orders.idempotency_key already established.
  IF p_idempotency_key IS NOT NULL THEN
    BEGIN
      INSERT INTO record_client_payment_idempotency_keys (idempotency_key)
      VALUES (p_idempotency_key);
    EXCEPTION WHEN unique_violation THEN
      -- Already processed (a prior call with this exact key already
      -- committed), or a concurrent call with the same key is already
      -- claiming it. Either way, this call must not allocate anything —
      -- skip straight to recomputing and returning the current state.
      v_already_claimed := true;
    END;
  END IF;

  IF NOT v_already_claimed THEN
    -- FOR UPDATE locks each row before we read its paid balance — serializes
    -- concurrent payment calls and prevents double-payment.
    FOR v_sale IN
      SELECT
        so.id,
        (so.total_amount - COALESCE(so.discount_amount, 0)) AS owed,
        COALESCE(
          (SELECT SUM(p.amount) FROM payments p WHERE p.order_id = so.id),
          0
        ) AS already_paid
      FROM sale_orders so
      WHERE so.business_id   = p_business_id
        AND so.customer_name = p_customer_name
        AND so.status        = 'credit'
      ORDER BY so.created_at ASC
      FOR UPDATE OF so
    LOOP
      IF v_remaining <= 0 THEN EXIT; END IF;

      v_outstanding := v_sale.owed - v_sale.already_paid;
      IF v_outstanding <= 0 THEN CONTINUE; END IF;

      v_allocated := LEAST(v_remaining, v_outstanding);
      v_new_paid  := v_sale.already_paid + v_allocated;

      v_payment_id := gen_random_uuid();

      INSERT INTO payments (id, order_id, customer_name, business_id, method, amount, date, seller_id)
      VALUES (
        v_payment_id, v_sale.id, p_customer_name,
        p_business_id, p_method, v_allocated, p_date,
        auth.uid()
      );

      v_payment_ids := array_append(v_payment_ids, v_payment_id);

      -- 1-cent tolerance for floating-point carry-over from older records
      IF v_new_paid >= v_sale.owed - 1 THEN
        UPDATE sale_orders SET status = 'paye', paid_at = now() WHERE id = v_sale.id;
      END IF;

      v_remaining := v_remaining - v_allocated;
    END LOOP;
  END IF;

  SELECT NOT EXISTS (
    SELECT 1 FROM sale_orders
    WHERE business_id   = p_business_id
      AND customer_name = p_customer_name
      AND status        = 'credit'
  ) INTO v_fully_settled;

  RETURN jsonb_build_object('fully_settled', v_fully_settled, 'payment_ids', to_jsonb(v_payment_ids));
END;
$$;

GRANT EXECUTE ON FUNCTION record_client_payment(uuid, text, numeric, text, date, uuid) TO authenticated;

-- ------------------------------------------------------------------
-- 7. submit_quick_sale — seller_id on the payment insert
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION submit_quick_sale(
  p_business_id      uuid,
  p_seller_id        uuid,
  p_unit_price       bigint,           -- cents (×100)
  p_qty              numeric DEFAULT 1,
  p_label            text    DEFAULT NULL,  -- free text, e.g. "Riz, sac de 5kg" — optional
  p_idempotency_key  uuid    DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product_id uuid;
  v_order_id   uuid;
  v_total      bigint;
  v_label      text;
BEGIN
  IF get_role(p_business_id) IS NULL OR get_role(p_business_id) NOT IN ('administrateur', 'manager', 'vendeur') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF get_role(p_business_id) = 'vendeur' AND p_seller_id != auth.uid() THEN
    RAISE EXCEPTION 'Un vendeur ne peut enregistrer que ses propres ventes' USING ERRCODE = 'P0001';
  END IF;

  IF p_unit_price IS NULL OR p_unit_price <= 0 THEN
    RAISE EXCEPTION 'Montant invalide' USING ERRCODE = 'P0001';
  END IF;

  IF p_qty IS NULL OR p_qty <= 0 THEN
    RAISE EXCEPTION 'Quantité invalide' USING ERRCODE = 'P0001';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_order_id FROM sale_orders WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN RETURN v_order_id; END IF;
  END IF;

  -- Get or create this business's single system product for quick sales —
  -- see migration_v198 header for why this can't just be
  -- submit_carnet_debt's own "Solde reporté" product.
  SELECT id INTO v_product_id
  FROM products
  WHERE business_id = p_business_id AND is_system = true AND name = 'Vente rapide' AND archived = false
  LIMIT 1;

  IF NOT FOUND THEN
    v_product_id := gen_random_uuid();
    INSERT INTO products (
      id, business_id, name, unit,
      cost_price, sale_price, stock_qty, reorder_level,
      archived, is_system, created_by, created_at, updated_at
    ) VALUES (
      v_product_id, p_business_id, 'Vente rapide', 'unité',
      0, 0, 999999, 0,
      false, true, p_seller_id, NOW(), NOW()
    );
  END IF;

  -- Never trust a client-supplied total — derive it from qty × unit price.
  v_total := ROUND(p_unit_price * p_qty);
  v_label := NULLIF(TRIM(COALESCE(p_label, '')), '');

  v_order_id := gen_random_uuid();

  BEGIN
    INSERT INTO sale_orders (
      id, business_id, seller_id,
      status, is_credit, paid_at, total_amount, discount_amount,
      sale_date, idempotency_key, created_at, updated_at, created_by
    ) VALUES (
      v_order_id, p_business_id, p_seller_id,
      'paye', false, now(), v_total, 0,
      CURRENT_DATE, coalesce(p_idempotency_key, gen_random_uuid()), NOW(), NOW(), p_seller_id
    );
  EXCEPTION WHEN unique_violation THEN
    -- Race: another concurrent call with the same key committed first —
    -- return its order instead of raising a raw duplicate-key error.
    IF p_idempotency_key IS NOT NULL THEN
      SELECT id INTO v_order_id FROM sale_orders WHERE idempotency_key = p_idempotency_key;
      IF FOUND THEN RETURN v_order_id; END IF;
    END IF;
    RAISE;
  END;

  -- product_name falls back to the placeholder's own "Vente rapide" name
  -- when nothing was typed — never a blank label on a receipt/notification.
  INSERT INTO so_lines (
    id, order_id, product_id, product_name,
    qty, unit_price, is_bulk
  ) VALUES (
    gen_random_uuid(), v_order_id, v_product_id, COALESCE(v_label, 'Vente rapide'),
    p_qty, p_unit_price, false
  );

  INSERT INTO payments (id, order_id, business_id, method, amount, date, seller_id)
  VALUES (
    gen_random_uuid(), v_order_id, p_business_id, 'especes', v_total, CURRENT_DATE,
    auth.uid()
  );

  RETURN v_order_id;
END;
$$;

GRANT EXECUTE ON FUNCTION submit_quick_sale(uuid, uuid, bigint, numeric, text, uuid) TO authenticated;

-- ------------------------------------------------------------------
-- 8. memberships DELETE policy — block any admin deletion when sole admin
-- ------------------------------------------------------------------
DROP POLICY IF EXISTS "Managers: retirer des membres" ON memberships;

-- Fix #2 — extend last-admin protection to the DELETE path. Previously only
-- a sole admin deleting THEIR OWN row was blocked; a manager could still
-- DELETE the sole admin's row. Now ANY deletion of an 'administrateur' row
-- is blocked while count_business_admins <= 1.
CREATE POLICY "Managers: retirer des membres"
  ON memberships FOR DELETE
  USING (
    get_role(business_id) IN ('administrateur', 'manager')
    AND NOT (
      role = 'administrateur'
      AND count_business_admins(business_id) <= 1
    )
  );
