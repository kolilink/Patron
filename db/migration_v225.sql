-- ============================================================
-- Patron — Migration v225
-- Run in Supabase SQL Editor AFTER migration_v224
--
-- SECURITY FIX: NULL-unsafe authorization guards.
--
-- get_role(bid) returns NULL for a caller with no membership in bid, and
-- auth.uid() is NULL for an unauthenticated (anon-key) caller. In plpgsql
--     IF NULL THEN RAISE ...
-- does NOT raise: the condition is only "true" when strictly TRUE. So
--     IF get_role(x) NOT IN ('administrateur','manager') THEN RAISE
--     IF v_owner != auth.uid() THEN RAISE
-- never fire for a non-member / anon caller. Combined with the default
-- PUBLIC EXECUTE grant, anyone who knows a row UUID could write.
--
-- Fixed here (guard line ONLY — each body is the exact live production body
-- as of 2026-10-04, so every prior fix is preserved; grants untouched,
-- CREATE OR REPLACE keeps them):
--   role guards   (add  get_role(..) IS NULL OR ..):
--     edit_withdrawal (v224), record_payment, void_payment,
--     void_purchase_order_receipt, attach_transaction_proof (2 guards)
--   identity guards (!= / <>  ->  IS DISTINCT FROM auth.uid()):
--     delete_transaction_proof, delete_market_post, mark_support_read,
--     submit_support_rating
-- edit_injection / record_withdrawal / confirm_payout / edit_sale / ... already
-- carry the IS NULL guard (checked against live bodies).
-- ============================================================

CREATE OR REPLACE FUNCTION public.edit_withdrawal(p_id uuid, p_amount bigint, p_injected_by_id uuid DEFAULT NULL::uuid, p_source_name text DEFAULT NULL::text, p_note text DEFAULT NULL::text, p_withdrawn_at date DEFAULT NULL::date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  IF get_role(v_business_id) IS NULL OR get_role(v_business_id) NOT IN ('administrateur', 'manager') THEN
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
$function$;

CREATE OR REPLACE FUNCTION public.record_payment(p_sale_id uuid, p_business_id uuid, p_amount numeric, p_method text, p_date date, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_sale       record;
  v_sale_id    uuid;
  v_already    numeric;
  v_owed       numeric;
  v_fully_paid boolean;
  v_payment_id uuid;
BEGIN
  IF get_role(p_business_id) IS NULL OR get_role(p_business_id) NOT IN ('administrateur', 'manager', 'vendeur') THEN
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
$function$;

CREATE OR REPLACE FUNCTION public.void_payment(p_payment_id uuid, p_business_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_payment    record;
  v_sale       record;
  v_owed       numeric;
  v_still_paid numeric;
BEGIN
  IF get_role(p_business_id) IS NULL OR get_role(p_business_id) NOT IN ('administrateur', 'manager', 'vendeur') THEN
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
$function$;

CREATE OR REPLACE FUNCTION public.void_purchase_order_receipt(p_batch_id uuid, p_business_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_batch          record;
  bl               record;
  v_current_stock  numeric;
  v_current_cost   bigint;
  v_new_stock      numeric;
  v_new_cost       bigint;
  total_lines      int;
  received_lines   int;
BEGIN
  IF get_role(p_business_id) IS NULL OR get_role(p_business_id) NOT IN ('administrateur', 'manager') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_batch
  FROM po_receipt_batches
  WHERE id = p_batch_id AND business_id = p_business_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Réception introuvable' USING ERRCODE = 'P0001';
  END IF;

  IF v_batch.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cette réception a déjà été annulée' USING ERRCODE = 'P0001';
  END IF;

  -- Safety pre-check first, whole batch: refuse cleanly rather than
  -- partially reversing if any line's stock has already been sold down
  -- below what this receipt added.
  FOR bl IN SELECT * FROM po_receipt_batch_lines WHERE batch_id = p_batch_id LOOP
    IF bl.variant_id IS NOT NULL THEN
      SELECT stock_qty INTO v_current_stock FROM product_variants WHERE id = bl.variant_id FOR UPDATE;
    ELSE
      SELECT stock_qty INTO v_current_stock FROM products WHERE id = bl.product_id AND business_id = p_business_id FOR UPDATE;
    END IF;
    IF v_current_stock IS NULL OR v_current_stock < bl.qty_received THEN
      RAISE EXCEPTION 'Stock déjà vendu depuis cette réception — annulation impossible' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  FOR bl IN SELECT * FROM po_receipt_batch_lines WHERE batch_id = p_batch_id LOOP
    IF bl.variant_id IS NOT NULL THEN
      SELECT stock_qty, cost_price INTO v_current_stock, v_current_cost
        FROM product_variants WHERE id = bl.variant_id;

      v_new_stock := v_current_stock - bl.qty_received;

      -- v221: NULL landed cost means the cost was unknown — decrement stock
      -- but do not invert the AVCO cost (there is nothing to invert).
      IF bl.landed_cost_cents IS NULL THEN
        UPDATE product_variants SET stock_qty = v_new_stock WHERE id = bl.variant_id;
      ELSE
        v_new_cost := CASE
          WHEN v_new_stock > 0 THEN
            GREATEST(0, ROUND((v_current_stock * v_current_cost - bl.qty_received * bl.landed_cost_cents) / v_new_stock))::bigint
          ELSE v_current_cost
        END;
        UPDATE product_variants SET stock_qty = v_new_stock, cost_price = v_new_cost WHERE id = bl.variant_id;
      END IF;

      UPDATE products SET stock_qty = stock_qty - bl.qty_received WHERE id = bl.product_id AND business_id = p_business_id;
    ELSE
      SELECT stock_qty, cost_price INTO v_current_stock, v_current_cost
        FROM products WHERE id = bl.product_id AND business_id = p_business_id;

      v_new_stock := v_current_stock - bl.qty_received;

      IF bl.landed_cost_cents IS NULL THEN
        UPDATE products SET stock_qty = v_new_stock WHERE id = bl.product_id AND business_id = p_business_id;
      ELSE
        v_new_cost := CASE
          WHEN v_new_stock > 0 THEN
            GREATEST(0, ROUND((v_current_stock * v_current_cost - bl.qty_received * bl.landed_cost_cents) / v_new_stock))::bigint
          ELSE v_current_cost
        END;
        UPDATE products SET stock_qty = v_new_stock, cost_price = v_new_cost
         WHERE id = bl.product_id AND business_id = p_business_id;
      END IF;
    END IF;

    INSERT INTO stock_moves (id, business_id, product_id, type, qty, ref_id, ref_type, note, created_by)
    VALUES (
      gen_random_uuid(), p_business_id, bl.product_id,
      'sortie', bl.qty_received, v_batch.po_id, 'annulation_reception',
      COALESCE(p_reason, 'Annulation de réception'), auth.uid()
    );

    UPDATE po_lines SET qty_received = GREATEST(0, qty_received - bl.qty_received) WHERE id = bl.po_line_id;
  END LOOP;

  -- Void the linked shipping expense (status flip, never a delete/amount edit —
  -- every cash/profit query in this codebase already filters to status='approuve').
  IF v_batch.expense_id IS NOT NULL THEN
    UPDATE expenses
       SET status = 'rejete'
     WHERE id = v_batch.expense_id AND status = 'approuve';
  END IF;

  UPDATE po_receipt_batches
     SET voided_at = now(), voided_by = auth.uid(), void_reason = p_reason
   WHERE id = p_batch_id;

  -- Reopen the PO to reflect what's actually still received.
  SELECT COUNT(*) INTO total_lines    FROM po_lines WHERE po_id = v_batch.po_id;
  SELECT COUNT(*) INTO received_lines FROM po_lines WHERE po_id = v_batch.po_id AND qty_received >= qty_ordered;

  UPDATE purchase_orders
     SET status = CASE
                     WHEN received_lines = total_lines AND total_lines > 0 THEN 'recu'
                     WHEN EXISTS (SELECT 1 FROM po_lines WHERE po_id = v_batch.po_id AND qty_received > 0) THEN 'recu_partiel'
                     ELSE 'envoye'
                   END,
         received_at = CASE WHEN received_lines = total_lines AND total_lines > 0 THEN received_at ELSE NULL END
   WHERE id = v_batch.po_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.attach_transaction_proof(p_kind text, p_id uuid, p_image_url text, p_image_width integer DEFAULT NULL::integer, p_image_height integer DEFAULT NULL::integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_business_id uuid;
  v_created_by  uuid;
  v_status      text;
  v_existing    text;
  v_role        text;
BEGIN
  IF p_image_url IS NULL OR length(trim(p_image_url)) = 0 THEN
    RAISE EXCEPTION 'Image manquante' USING ERRCODE = 'P0001';
  END IF;

  IF p_kind = 'apport' THEN
    SELECT business_id, proof_image_url
      INTO v_business_id, v_existing
      FROM capital_injections WHERE id = p_id;
  ELSIF p_kind = 'expense' THEN
    SELECT business_id, created_by, status, proof_image_url
      INTO v_business_id, v_created_by, v_status, v_existing
      FROM expenses WHERE id = p_id;
  ELSIF p_kind = 'purchase_order' THEN
    SELECT business_id, proof_image_url
      INTO v_business_id, v_existing
      FROM purchase_orders WHERE id = p_id;
  ELSE
    RAISE EXCEPTION 'Type de preuve inconnu' USING ERRCODE = 'P0001';
  END IF;

  IF v_business_id IS NULL THEN
    RAISE EXCEPTION 'Enregistrement introuvable' USING ERRCODE = 'P0001';
  END IF;

  v_role := get_role(v_business_id);

  IF p_kind = 'expense' THEN
    IF v_role IS NULL OR NOT (v_role IN ('administrateur', 'manager')
            OR (v_created_by = auth.uid() AND v_status = 'en_attente')) THEN
      RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    IF v_role IS NULL OR v_role NOT IN ('administrateur', 'manager') THEN
      RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF v_existing IS NOT NULL THEN
    RAISE EXCEPTION 'Une preuve est déjà attachée' USING ERRCODE = 'P0001';
  END IF;

  IF p_kind = 'apport' THEN
    UPDATE capital_injections
      SET proof_image_url    = p_image_url,
          proof_image_width  = p_image_width,
          proof_image_height = p_image_height,
          proof_attached_by  = auth.uid(),
          proof_attached_at  = now()
      WHERE id = p_id;
  ELSIF p_kind = 'expense' THEN
    UPDATE expenses
      SET proof_image_url    = p_image_url,
          proof_image_width  = p_image_width,
          proof_image_height = p_image_height,
          proof_attached_by  = auth.uid(),
          proof_attached_at  = now()
      WHERE id = p_id;
  ELSIF p_kind = 'purchase_order' THEN
    UPDATE purchase_orders
      SET proof_image_url    = p_image_url,
          proof_image_width  = p_image_width,
          proof_image_height = p_image_height,
          proof_attached_by  = auth.uid(),
          proof_attached_at  = now()
      WHERE id = p_id;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.delete_transaction_proof(p_kind text, p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_business_id   uuid;
  v_attached_by   uuid;
  v_attached_at   timestamptz;
  v_existing      text;
BEGIN
  IF p_kind = 'apport' THEN
    SELECT business_id, proof_image_url, proof_attached_by, proof_attached_at
      INTO v_business_id, v_existing, v_attached_by, v_attached_at
      FROM capital_injections WHERE id = p_id;
  ELSIF p_kind = 'expense' THEN
    SELECT business_id, proof_image_url, proof_attached_by, proof_attached_at
      INTO v_business_id, v_existing, v_attached_by, v_attached_at
      FROM expenses WHERE id = p_id;
  ELSIF p_kind = 'purchase_order' THEN
    SELECT business_id, proof_image_url, proof_attached_by, proof_attached_at
      INTO v_business_id, v_existing, v_attached_by, v_attached_at
      FROM purchase_orders WHERE id = p_id;
  ELSE
    RAISE EXCEPTION 'Type de preuve inconnu' USING ERRCODE = 'P0001';
  END IF;

  IF v_business_id IS NULL OR v_existing IS NULL THEN
    RAISE EXCEPTION 'Aucune image à supprimer' USING ERRCODE = 'P0001';
  END IF;

  -- Deliberately narrower than attach's role gate: not admin/manager in
  -- general, specifically whoever ran the attach call — matches the exact
  -- rule requested ("only the person that added it can delete it").
  IF v_attached_by IS NULL OR v_attached_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF v_attached_at IS NULL OR now() - v_attached_at > interval '24 hours' THEN
    RAISE EXCEPTION 'Le délai de 24 heures pour supprimer cette image est dépassé' USING ERRCODE = 'P0001';
  END IF;

  IF p_kind = 'apport' THEN
    UPDATE capital_injections
      SET proof_image_url = NULL, proof_image_width = NULL, proof_image_height = NULL,
          proof_attached_by = NULL, proof_attached_at = NULL
      WHERE id = p_id;
  ELSIF p_kind = 'expense' THEN
    UPDATE expenses
      SET proof_image_url = NULL, proof_image_width = NULL, proof_image_height = NULL,
          proof_attached_by = NULL, proof_attached_at = NULL
      WHERE id = p_id;
  ELSIF p_kind = 'purchase_order' THEN
    UPDATE purchase_orders
      SET proof_image_url = NULL, proof_image_width = NULL, proof_image_height = NULL,
          proof_attached_by = NULL, proof_attached_at = NULL
      WHERE id = p_id;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.delete_market_post(p_post_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_author uuid;
BEGIN
  SELECT author_id INTO v_author FROM market_posts WHERE id = p_post_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_author IS DISTINCT FROM auth.uid() AND NOT is_founder() THEN
    RAISE EXCEPTION 'Vous ne pouvez supprimer que vos propres posts' USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM market_posts WHERE id = p_post_id;
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.mark_support_read(p_conversation_id uuid, p_as_founder boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_owner uuid;
BEGIN
  SELECT merchant_user_id INTO v_owner FROM support_conversations WHERE id = p_conversation_id;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Conversation introuvable' USING ERRCODE = 'P0001';
  END IF;

  IF p_as_founder THEN
    IF NOT is_founder() THEN
      RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
    END IF;
    UPDATE support_conversations SET founder_last_read_at = now() WHERE id = p_conversation_id;
  ELSE
    IF v_owner IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
    END IF;
    UPDATE support_conversations SET merchant_last_read_at = now() WHERE id = p_conversation_id;
  END IF;

  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.submit_support_rating(p_conversation_id uuid, p_rating smallint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_owner uuid;
BEGIN
  IF p_rating < 1 OR p_rating > 5 THEN
    RAISE EXCEPTION 'Note invalide' USING ERRCODE = 'P0001';
  END IF;

  SELECT merchant_user_id INTO v_owner FROM support_conversations WHERE id = p_conversation_id;
  IF v_owner IS NULL OR v_owner IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  UPDATE support_conversations
  SET rating = p_rating, rated_at = now()
  WHERE id = p_conversation_id;

  RETURN true;
END;
$function$;
