-- ============================================================
-- Patron — Migration v153
-- Run in Supabase SQL Editor AFTER migration_v152
--
-- Fix: edit_sale()'s two money-mismatch RAISE EXCEPTION messages
-- ("Le montant déjà payé (%) dépasserait le nouveau montant dû (%)"
-- and "Le total payé (%) doit correspondre au montant dû (%)")
-- interpolated v_new_paid/v_new_owed directly — both BIGINT cents
-- (×100, this app's universal monetary convention, see CLAUDE.md) —
-- with no ÷100 conversion. A real mismatch of 6 000 GNF paid vs
-- 5 000 GNF owed surfaced to the merchant as "(600000)" vs
-- "(500000)", reading as if two extra zeros had been typed. Every
-- other place in this codebase divides by 100 before a monetary
-- value reaches a human (client-side via formatAmount(); here,
-- server-side since a Postgres error message has no client
-- formatting pass in between) — these two lines were the only
-- monetary values ever interpolated into a RAISE EXCEPTION in this
-- codebase and were missed when edit_sale() was first written.
--
-- Only the two message lines change — rounds to the nearest whole
-- display unit (exact for GNF/XOF, this app's primary currencies,
-- since their cents values are always ×100 of a whole number; a
-- non-whole-unit currency would round to the nearest unit in the
-- message text only, never affecting the exact-cents comparison
-- logic above it, which is untouched).
-- ============================================================

CREATE OR REPLACE FUNCTION public.edit_sale(
  p_sale_id          uuid,
  p_business_id      uuid,
  p_customer_name    text    DEFAULT NULL,
  p_client_id        uuid    DEFAULT NULL,
  p_due_date         date    DEFAULT NULL,
  p_discount_amount  bigint  DEFAULT 0,
  p_line_edits       jsonb   DEFAULT '[]',
  p_payment_edits    jsonb   DEFAULT '[]',
  p_reason           text    DEFAULT NULL
)
RETURNS sale_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sale         sale_orders;
  v_max_edits    int;
  v_window_hours int;
  v_line         jsonb;
  v_line_row     so_lines;
  v_pay          jsonb;
  v_pay_row      payments;
  v_new_total    bigint;
  v_new_paid     bigint;
  v_new_owed     bigint;
  v_cost         bigint;
  v_old_profit   bigint;
  v_new_profit   bigint;
  v_delta        bigint;
  v_investor     RECORD;
  v_before       jsonb;
  v_after        jsonb;
  v_result       sale_orders;
BEGIN
  IF get_role(p_business_id) NOT IN ('administrateur', 'manager') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_sale FROM sale_orders WHERE id = p_sale_id AND business_id = p_business_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vente introuvable' USING ERRCODE = 'P0001';
  END IF;

  IF v_sale.status NOT IN ('paye', 'credit') THEN
    RAISE EXCEPTION 'Seules les ventes payées ou à crédit peuvent être modifiées' USING ERRCODE = 'P0001';
  END IF;

  SELECT value INTO v_max_edits    FROM app_config WHERE key = 'sale_edit_max_count';
  SELECT value INTO v_window_hours FROM app_config WHERE key = 'sale_edit_window_hours';

  IF v_sale.edit_count >= v_max_edits THEN
    RAISE EXCEPTION 'Cette vente a atteint le nombre maximum de modifications (%). Annulez-la et recréez-la si besoin.', v_max_edits USING ERRCODE = 'P0001';
  END IF;

  IF now() - v_sale.created_at > (v_window_hours || ' hours')::interval THEN
    RAISE EXCEPTION 'Le délai de modification (% heures) est dépassé pour cette vente', v_window_hours USING ERRCODE = 'P0001';
  END IF;

  IF p_discount_amount < 0 THEN
    RAISE EXCEPTION 'La remise ne peut pas être négative' USING ERRCODE = 'P0001';
  END IF;

  -- Snapshot "before" — whole shape, taken before any write below.
  SELECT jsonb_build_object(
    'customer_name',   v_sale.customer_name,
    'client_id',       v_sale.client_id,
    'due_date',        v_sale.due_date,
    'total_amount',    v_sale.total_amount,
    'discount_amount', v_sale.discount_amount,
    'lines', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'line_id', id, 'product_name', COALESCE(product_name, ''), 'unit_price', unit_price
             ) ORDER BY id), '[]'::jsonb)
      FROM so_lines WHERE order_id = p_sale_id
    ),
    'payments', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'payment_id', id, 'method', method, 'amount', amount, 'ref_external', ref_external
             ) ORDER BY id), '[]'::jsonb)
      FROM payments WHERE order_id = p_sale_id
    )
  ) INTO v_before;

  -- Apply line-price corrections (partial list — only the lines being changed).
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_line_edits) LOOP
    SELECT * INTO v_line_row FROM so_lines
      WHERE id = (v_line->>'line_id')::uuid AND order_id = p_sale_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Ligne de vente introuvable' USING ERRCODE = 'P0001';
    END IF;
    IF (v_line->>'unit_price')::bigint < 0 THEN
      RAISE EXCEPTION 'Le prix ne peut pas être négatif' USING ERRCODE = 'P0001';
    END IF;

    IF (v_line->>'unit_price')::bigint != v_line_row.unit_price THEN
      -- Investor profit-share delta: submit_sale credited investor_balance
      -- once at sale time based on the original price; that ledger is
      -- additive, never recomputed from source, so a price correction
      -- must apply the delta here or the balance silently drifts forever.
      v_cost       := COALESCE(v_line_row.cost_price_at_sale, 0);
      v_old_profit := GREATEST(0, (v_line_row.unit_price - v_cost) * v_line_row.qty);
      v_new_profit := GREATEST(0, ((v_line->>'unit_price')::bigint - v_cost) * v_line_row.qty);
      v_delta      := v_new_profit - v_old_profit;

      IF v_delta != 0 THEN
        FOR v_investor IN
          SELECT m.user_id, mps.profit_share
          FROM membership_product_scope mps
          JOIN memberships m ON m.id = mps.membership_id
          WHERE mps.product_id  = v_line_row.product_id
            AND m.business_id   = p_business_id
            AND m.role          = 'investisseur'
            AND mps.profit_share > 0
        LOOP
          INSERT INTO investor_balance (business_id, investor_id, balance, updated_at)
          VALUES (
            p_business_id, v_investor.user_id,
            ROUND(v_delta * v_investor.profit_share / 100.0)::bigint, now()
          )
          ON CONFLICT (business_id, investor_id) DO UPDATE
            SET balance    = investor_balance.balance
                           + ROUND(v_delta * v_investor.profit_share / 100.0)::bigint,
                updated_at = now();
        END LOOP;
      END IF;

      UPDATE so_lines SET unit_price = (v_line->>'unit_price')::bigint WHERE id = v_line_row.id;
    END IF;
  END LOOP;

  -- total_amount is always server-derived from the lines as they now
  -- stand — never trusted from the client — so check #9 (total vs. sum
  -- of lines) holds by construction, not by being patched.
  SELECT COALESCE(SUM(qty * unit_price), 0)::bigint INTO v_new_total
  FROM so_lines WHERE order_id = p_sale_id;

  IF p_discount_amount >= v_new_total THEN
    RAISE EXCEPTION 'La remise doit être inférieure au total' USING ERRCODE = 'P0001';
  END IF;

  -- Apply payment corrections (partial list — only the payments being changed).
  FOR v_pay IN SELECT * FROM jsonb_array_elements(p_payment_edits) LOOP
    SELECT * INTO v_pay_row FROM payments
      WHERE id = (v_pay->>'payment_id')::uuid AND order_id = p_sale_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Paiement introuvable' USING ERRCODE = 'P0001';
    END IF;
    IF (v_pay->>'amount')::bigint < 0 THEN
      RAISE EXCEPTION 'Le montant payé ne peut pas être négatif' USING ERRCODE = 'P0001';
    END IF;

    UPDATE payments SET
      method       = v_pay->>'method',
      amount       = (v_pay->>'amount')::bigint,
      ref_external = nullif(trim(coalesce(v_pay->>'ref_external', '')), '')
    WHERE id = v_pay_row.id;
  END LOOP;

  SELECT COALESCE(SUM(amount), 0)::bigint INTO v_new_paid FROM payments WHERE order_id = p_sale_id;
  v_new_owed := v_new_total - p_discount_amount;

  -- The one hard money rule: an edit can correct numbers, but it can
  -- never leave the sale in a state reconciliation would flag as wrong.
  -- (v153: display values divided by 100 — v_new_paid/v_new_owed are
  -- BIGINT cents, the comparisons above stay exact-cents throughout.)
  IF v_sale.status = 'credit' THEN
    IF v_new_paid > v_new_owed THEN
      RAISE EXCEPTION 'Le montant déjà payé (%) dépasserait le nouveau montant dû (%) — ajustez aussi le paiement', ROUND(v_new_paid / 100.0)::bigint, ROUND(v_new_owed / 100.0)::bigint USING ERRCODE = 'P0001';
    END IF;
  ELSE -- 'paye'
    IF v_new_paid != v_new_owed THEN
      RAISE EXCEPTION 'Le total payé (%) doit correspondre au montant dû (%) pour une vente payée — ajustez aussi le paiement', ROUND(v_new_paid / 100.0)::bigint, ROUND(v_new_owed / 100.0)::bigint USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE sale_orders SET
    customer_name   = nullif(trim(coalesce(p_customer_name, '')), ''),
    client_id       = p_client_id,
    due_date        = CASE WHEN v_sale.is_credit THEN p_due_date ELSE NULL END,
    total_amount    = v_new_total,
    discount_amount = p_discount_amount,
    edit_count      = v_sale.edit_count + 1,
    last_edited_at  = now(),
    last_edited_by  = auth.uid()
  WHERE id = p_sale_id
  RETURNING * INTO v_result;

  SELECT jsonb_build_object(
    'customer_name',   v_result.customer_name,
    'client_id',       v_result.client_id,
    'due_date',        v_result.due_date,
    'total_amount',    v_result.total_amount,
    'discount_amount', v_result.discount_amount,
    'lines', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'line_id', id, 'product_name', COALESCE(product_name, ''), 'unit_price', unit_price
             ) ORDER BY id), '[]'::jsonb)
      FROM so_lines WHERE order_id = p_sale_id
    ),
    'payments', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'payment_id', id, 'method', method, 'amount', amount, 'ref_external', ref_external
             ) ORDER BY id), '[]'::jsonb)
      FROM payments WHERE order_id = p_sale_id
    )
  ) INTO v_after;

  INSERT INTO sale_order_edits (id, order_id, edit_number, edited_by, reason, before, after)
  VALUES (gen_random_uuid(), p_sale_id, v_result.edit_count, auth.uid(), nullif(trim(coalesce(p_reason, '')), ''), v_before, v_after);

  RETURN v_result;
END;
$$;

-- Signature is unchanged (same 9 params) so CREATE OR REPLACE alone is
-- safe here — no risk of a duplicate overload the way an added/removed
-- parameter would cause (see CLAUDE.md's migration_v132.sql note).
