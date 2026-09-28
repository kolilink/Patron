-- ============================================================
-- Patron — Migration v151
-- Run in Supabase SQL Editor AFTER migration_v150
--
-- Sale editing: instead of only cancel-or-keep, admin/manager can now
-- correct a mistaken sale (wrong price, wrong discount, wrong customer,
-- wrong payment) in place, with a full audit trail — never a silent
-- overwrite. Scoped deliberately to fields with no stock_moves impact
-- (quantity/product substitution is NOT included — that would require
-- rewriting reconciliation checks #1/#2/#4, which are keyed on
-- so_lines.qty vs stock_moves; left as a future phase, not needed for
-- the actual problem being solved: typos in price/discount/customer/
-- payment, not wrong quantities).
--
--   1. sale_orders gains edit_count / last_edited_at / last_edited_by.
--   2. sale_order_edits — one row per edit call, before/after jsonb
--      snapshot (whole-shape, not a field-by-field diff table) so the
--      UI can show exactly what changed without a rigid schema that
--      has to grow every time a new editable field is added.
--   3. app_config gains sale_edit_max_count (2) and sale_edit_window_hours
--      (48) — reuses the config table migration_v147.sql already built
--      for Alpha's quota, so tuning either number later is one UPDATE,
--      not another migration. set_sale_edit_limit() is the setter.
--   4. edit_sale() — admin/manager only (same boundary sale_orders'
--      UPDATE RLS policy already draws; a vendeur has never had a way
--      to mutate a sale row directly, only cancel_sale on their own
--      sales). Rejects outside the 48h window or past 2 edits, both
--      read live from app_config. Recomputes total_amount server-side
--      from so_lines (never trusts a client-supplied total), and
--      enforces the one hard money rule: for a 'credit' sale, payments
--      can never exceed the new owed amount; for a 'paye' sale, payments
--      must exactly equal it — reject and ask for a payment adjustment
--      in the same call rather than ever leaving the two out of sync.
--      Also applies the same investor-profit-share delta math
--      submit_sale already runs, so a unit_price correction doesn't
--      silently desync investor_balance (that ledger is additive, not
--      recomputed from source — an edit that only touched so_lines
--      would otherwise leave it permanently wrong).
--   5. run_display_checks() gains checks 79-80: #79 (warning) lists
--      every sale edited in the last 90 days for founder visibility,
--      same posture as #78 for capital-injection edits. #80 (critical)
--      is the actual fraud signal — fires only when an edit moved
--      money in the merchant's favor (total down, discount up, or
--      amount paid down), since a genuine typo fix is just as likely
--      to go up as down.
--
-- Deliberately online-only on the client side (not queued through the
-- offline sync_queue) — the 48h window is checked against a live
-- server clock, so a queued edit replayed after a connectivity gap
-- could silently fail the window check with no clear signal to the
-- admin. Same call Alpha's composer already made for the same reason.
-- ============================================================

-- ─── 1. sale_orders + sale_order_edits ─────────────────────────────────────

ALTER TABLE sale_orders
  ADD COLUMN IF NOT EXISTS edit_count     int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_edited_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_edited_by uuid REFERENCES profiles(id);

CREATE TABLE IF NOT EXISTS sale_order_edits (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid        NOT NULL REFERENCES sale_orders(id) ON DELETE CASCADE,
  edit_number int         NOT NULL,
  edited_by   uuid        NOT NULL REFERENCES profiles(id),
  edited_at   timestamptz NOT NULL DEFAULT now(),
  reason      text,
  before      jsonb       NOT NULL,
  after       jsonb       NOT NULL
);

ALTER TABLE sale_order_edits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Voir historique modifications ventes" ON sale_order_edits;
CREATE POLICY "Voir historique modifications ventes"
  ON sale_order_edits FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM sale_orders so
      WHERE so.id = order_id
        AND is_member(so.business_id)
        AND get_role(so.business_id) != 'investisseur'
    )
  );
-- No INSERT/UPDATE/DELETE policy for authenticated — writes only via
-- edit_sale() below, same posture as reconciliation_findings etc.

-- ─── 2. Live-tunable limits (reuses app_config from migration_v147.sql) ────

INSERT INTO app_config (key, value) VALUES
  ('sale_edit_max_count',     2),
  ('sale_edit_window_hours', 48)
ON CONFLICT (key) DO NOTHING;

-- set_sale_edit_limit('max_count' | 'window_hours', new_value) — mirrors
-- set_alpha_daily_limit(). To check current values: SELECT * FROM app_config;
CREATE OR REPLACE FUNCTION set_sale_edit_limit(p_setting text, p_value int)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_setting NOT IN ('max_count', 'window_hours') THEN
    RAISE EXCEPTION 'p_setting must be ''max_count'' or ''window_hours''';
  END IF;
  IF p_value < 1 THEN
    RAISE EXCEPTION 'p_value must be a positive number';
  END IF;

  UPDATE app_config
  SET value = p_value, updated_at = now()
  WHERE key = 'sale_edit_' || p_setting;
END;
$$;

REVOKE EXECUTE ON FUNCTION set_sale_edit_limit(text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION set_sale_edit_limit(text, int) TO service_role;

-- ─── 3. edit_sale() ─────────────────────────────────────────────────────────
--
-- p_line_edits / p_payment_edits only need to contain the entries that
-- actually changed (unlike edit_injection's "always send the full row"
-- convention) — total_amount is recomputed server-side from ALL of
-- so_lines regardless of which lines appeared in the payload, so a
-- partial list is still correct, and it keeps the client payload small.
-- p_customer_name / p_client_id / p_due_date / p_discount_amount follow
-- the simpler "always send the current-or-new value" convention instead,
-- since those are single scalar fields with no natural partial form.

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
  IF v_sale.status = 'credit' THEN
    IF v_new_paid > v_new_owed THEN
      RAISE EXCEPTION 'Le montant déjà payé (%) dépasserait le nouveau montant dû (%) — ajustez aussi le paiement', v_new_paid, v_new_owed USING ERRCODE = 'P0001';
    END IF;
  ELSE -- 'paye'
    IF v_new_paid != v_new_owed THEN
      RAISE EXCEPTION 'Le total payé (%) doit correspondre au montant dû (%) pour une vente payée — ajustez aussi le paiement', v_new_paid, v_new_owed USING ERRCODE = 'P0001';
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

REVOKE EXECUTE ON FUNCTION public.edit_sale(uuid, uuid, text, uuid, date, bigint, jsonb, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.edit_sale(uuid, uuid, text, uuid, date, bigint, jsonb, jsonb, text) TO authenticated;

-- ─── 4. run_display_checks() — adds checks 79-80 ───────────────────────────
-- Full body carried forward unchanged from migration_v116.sql (checks
-- 69-78) with 79-80 appended — CREATE OR REPLACE replaces the whole
-- function body, so nothing here may be dropped.

CREATE OR REPLACE FUNCTION run_display_checks(p_run_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN

  -- ── Check 69: Orders missing sale_date ───────────────────────────────────
  INSERT INTO reconciliation_findings
    (run_id, check_id, domain, check_name, severity,
     business_id, entity_type, entity_id, detail, affected_count)
  SELECT
    p_run_id, 69, 'Affichage', 'Vente sans date de vente', 'warning',
    so.business_id, 'sale_order', so.id,
    format('Vente %s: sale_date NULL — absente des rapports (filtrée par période)', so.id),
    1
  FROM sale_orders so
  WHERE so.sale_date IS NULL
    AND so.status NOT IN ('annule', 'brouillon');

  -- ── Check 70: Cash on hand negative ──────────────────────────────────────
  INSERT INTO reconciliation_findings
    (run_id, check_id, domain, check_name, severity,
     business_id, detail, affected_count)
  SELECT
    p_run_id, 70, 'Affichage', 'Argent disponible négatif', 'warning',
    b.id,
    format('"%s": argent disponible = %s centimes (sorties > entrées — vérifier dépenses ou apports manquants)',
      b.name, cash_balance),
    1
  FROM businesses b
  JOIN LATERAL (
    SELECT
      COALESCE((SELECT SUM(amount)         FROM payments         WHERE business_id = b.id), 0)
      + COALESCE((SELECT SUM(amount)       FROM capital_injections WHERE business_id = b.id), 0)
      - COALESCE((SELECT SUM(amount)       FROM expenses WHERE business_id = b.id AND status = 'approuve'), 0)
      - COALESCE((SELECT SUM(amount_cents) FROM supplier_payments WHERE business_id = b.id), 0)
      - COALESCE((SELECT SUM(paid_amount)  FROM investor_payouts  WHERE business_id = b.id AND status = 'paye'), 0)
      AS cash_balance
  ) calc ON true
  WHERE calc.cash_balance < -10000000; -- More than 100 000 GNF negative (×100 cents)

  -- ── Check 71: Stock losses with zero cost (invisible in profit) ───────────
  INSERT INTO reconciliation_findings
    (run_id, check_id, domain, check_name, severity,
     business_id, entity_type, entity_id, detail, affected_count)
  SELECT
    p_run_id, 71, 'Affichage', 'Perte de stock avec coût nul', 'warning',
    sm.business_id, 'stock_move', sm.id,
    format('Perte de %s unité(s) de "%s" avec coût = 0 — non déductible du bénéfice, perte réelle sous-estimée',
      sm.qty, p.name),
    1
  FROM stock_moves sm
  JOIN products p ON p.id = sm.product_id
  WHERE sm.type = 'perte'
    AND sm.created_at >= now() - interval '90 days'
    AND COALESCE(p.cost_price, 0) = 0
    AND NOT COALESCE(p.is_system, false);

  -- ── Check 72: Manual transport_achat without PO link ─────────────────────
  INSERT INTO reconciliation_findings
    (run_id, check_id, domain, check_name, severity,
     business_id, entity_type, entity_id, detail, affected_count)
  SELECT
    p_run_id, 72, 'Affichage', 'Transport achat non lié à une commande', 'warning',
    e.business_id, 'expense', e.id,
    format('Dépense transport "%s" (%s centimes) sans commande fournisseur — possible doublon avec le coût de revient AVCO',
      e.description, e.amount),
    1
  FROM expenses e
  WHERE e.category = 'transport_achat'
    AND e.purchase_order_id IS NULL
    AND e.status = 'approuve'
    AND e.date >= CURRENT_DATE - 90;

  -- ── Check 73: Investor balance negative ──────────────────────────────────
  INSERT INTO reconciliation_findings
    (run_id, check_id, domain, check_name, severity,
     business_id, detail, affected_count)
  SELECT
    p_run_id, 73, 'Affichage', 'Solde investisseur négatif', 'critical',
    ib.business_id,
    format('Boutique %s: solde investisseur %s négatif (%s centimes) — retraits confirmés > bénéfices accumulés',
      ib.business_id, ib.investor_id, ib.balance),
    1
  FROM investor_balance ib
  WHERE ib.balance < 0;

  -- ── Check 74: Revenue aggregate vs line-items aggregate ───────────────────
  INSERT INTO reconciliation_findings
    (run_id, check_id, domain, check_name, severity,
     business_id, detail, affected_count)
  WITH order_totals AS (
    SELECT so.business_id, so.id,
      SUM(so.total_amount - COALESCE(so.discount_amount, 0)) AS order_total
    FROM sale_orders so
    WHERE so.status IN ('paye', 'credit')
      AND so.sale_date >= CURRENT_DATE - 30
    GROUP BY so.business_id, so.id
  ),
  line_totals AS (
    SELECT so.business_id, so.id,
      SUM(sl.unit_price * sl.qty) AS lines_total
    FROM sale_orders so
    JOIN so_lines sl ON sl.order_id = so.id
    LEFT JOIN products p ON p.id = sl.product_id
    WHERE so.status IN ('paye', 'credit')
      AND so.sale_date >= CURRENT_DATE - 30
      AND NOT COALESCE(p.is_system, false)
    GROUP BY so.business_id, so.id
  ),
  agg AS (
    SELECT
      ot.business_id,
      SUM(ot.order_total) AS order_total,
      SUM(COALESCE(lt.lines_total, 0)) AS lines_total
    FROM order_totals ot
    LEFT JOIN line_totals lt ON lt.id = ot.id
    GROUP BY ot.business_id
    HAVING ABS(SUM(ot.order_total) - SUM(COALESCE(lt.lines_total, 0))) > 10000 -- 100 GNF tolerance
  )
  SELECT
    p_run_id, 74, 'Affichage', 'Écart revenu commandes vs lignes (30 jours)', 'warning',
    agg.business_id,
    format('Boutique %s: total commandes (%s GNF×100) ≠ total lignes (%s GNF×100) — écart %s centimes',
      agg.business_id, agg.order_total, agg.lines_total, ABS(agg.order_total - agg.lines_total)),
    1
  FROM agg;

  -- ── Check 75: Credit negative per order ──────────────────────────────────
  INSERT INTO reconciliation_findings
    (run_id, check_id, domain, check_name, severity,
     business_id, entity_type, entity_id, detail, affected_count)
  WITH paid_per_order AS (
    SELECT order_id, SUM(amount) AS total_paid
    FROM payments
    GROUP BY order_id
  )
  SELECT
    p_run_id, 75, 'Affichage', 'Crédit négatif affiché', 'critical',
    so.business_id, 'sale_order', so.id,
    format('Vente %s: collecté (%s) > montant dû (%s) — crédit négatif de %s centimes affiché dans les rapports',
      so.id,
      COALESCE(ppo.total_paid, 0),
      so.total_amount - COALESCE(so.discount_amount, 0),
      COALESCE(ppo.total_paid, 0) - (so.total_amount - COALESCE(so.discount_amount, 0))),
    1
  FROM sale_orders so
  LEFT JOIN paid_per_order ppo ON ppo.order_id = so.id
  WHERE so.status = 'credit'
    AND COALESCE(ppo.total_paid, 0) > (so.total_amount - COALESCE(so.discount_amount, 0)) + 100;

  -- ── Check 76: Product with negative cost_price ───────────────────────────
  INSERT INTO reconciliation_findings
    (run_id, check_id, domain, check_name, severity,
     business_id, entity_type, entity_id, detail, affected_count)
  SELECT
    p_run_id, 76, 'Affichage', 'Coût produit négatif', 'critical',
    p.business_id, 'product', p.id,
    format('Produit "%s" a un coût négatif (%s centimes) — COGS et valeur stock faussés dans les rapports',
      p.name, p.cost_price),
    1
  FROM products p
  WHERE p.cost_price < 0
    AND NOT p.archived
    AND NOT COALESCE(p.is_system, false);

  -- ── Check 77: Contributor's net capital position negative ────────────────
  INSERT INTO reconciliation_findings
    (run_id, check_id, domain, check_name, severity,
     business_id, detail, affected_count)
  SELECT
    p_run_id, 77, 'Affichage', 'Apport net négatif pour un contributeur', 'critical',
    agg.business_id,
    format('Contributeur "%s": apport net = %s centimes (retraits > apports enregistrés pour cette personne)',
      COALESCE(agg.source_name, agg.injected_by_id::text), agg.net_amount),
    1
  FROM (
    SELECT business_id, injected_by_id, source_name, SUM(amount) AS net_amount
    FROM capital_injections
    WHERE injected_by_id IS NOT NULL OR source_name IS NOT NULL
    GROUP BY business_id, injected_by_id, source_name
    HAVING SUM(amount) < 0
  ) agg;

  -- ── Check 78: Capital injection edited or withdrawn recently ─────────────
  INSERT INTO reconciliation_findings
    (run_id, check_id, domain, check_name, severity,
     business_id, entity_type, entity_id, detail, affected_count)
  SELECT
    p_run_id, 78, 'Affichage',
    CASE WHEN ci.amount < 0 THEN 'Retrait de capital enregistré' ELSE 'Apport corrigé manuellement' END,
    'warning',
    ci.business_id, 'capital_injection', ci.id,
    CASE WHEN ci.amount < 0
      THEN format('Retrait de %s centimes enregistré le %s', ABS(ci.amount), ci.injected_at)
      ELSE format('Apport de %s centimes modifié le %s', ci.amount, ci.edited_at::date)
    END,
    1
  FROM capital_injections ci
  WHERE (ci.amount < 0 AND ci.injected_at >= CURRENT_DATE - 90)
     OR (ci.edited_at IS NOT NULL AND ci.edited_at >= now() - interval '90 days');

  -- ── Check 79: Sale edited recently (visibility only) ─────────────────────
  -- edit_sale() (migration_v151.sql) is admin/manager only. Not an
  -- accusation — just a nightly list of every correction, same posture
  -- as check 78 for capital-injection edits.
  INSERT INTO reconciliation_findings
    (run_id, check_id, domain, check_name, severity,
     business_id, entity_type, entity_id, detail, affected_count)
  SELECT
    p_run_id, 79, 'Affichage', 'Vente modifiée', 'warning',
    so.business_id, 'sale_order', so.id,
    format('Vente %s modifiée %s fois — dernière modification le %s par %s',
      so.id, so.edit_count, so.last_edited_at::date, COALESCE(pr.name, so.last_edited_by::text)),
    1
  FROM sale_orders so
  LEFT JOIN profiles pr ON pr.id = so.last_edited_by
  WHERE so.edit_count > 0
    AND so.last_edited_at >= now() - interval '90 days';

  -- ── Check 80: Sale edited in the merchant's favor (the real fraud signal) ─
  -- Fires only when an edit moved money the merchant's way: total went
  -- down, discount went up, or amount paid went down. A genuine typo fix
  -- is just as likely to go up as down — a one-directional pattern is
  -- the actual tell, not the edit itself.
  INSERT INTO reconciliation_findings
    (run_id, check_id, domain, check_name, severity,
     business_id, entity_type, entity_id, detail, affected_count)
  SELECT
    p_run_id, 80, 'Affichage', 'Vente modifiée à la baisse', 'critical',
    diff.business_id, 'sale_order', diff.order_id,
    format('Vente %s modifiée par %s le %s: total %s→%s, remise %s→%s, payé %s→%s',
      diff.order_id, COALESCE(pr.name, diff.edited_by::text), diff.edited_at::date,
      diff.old_total, diff.new_total, diff.old_discount, diff.new_discount, diff.old_paid, diff.new_paid),
    1
  FROM (
    SELECT
      se.order_id, se.edited_by, se.edited_at, so.business_id,
      (se.before->>'total_amount')::bigint    AS old_total,
      (se.after->>'total_amount')::bigint     AS new_total,
      (se.before->>'discount_amount')::bigint AS old_discount,
      (se.after->>'discount_amount')::bigint  AS new_discount,
      (SELECT COALESCE(SUM((p->>'amount')::bigint), 0) FROM jsonb_array_elements(se.before->'payments') p) AS old_paid,
      (SELECT COALESCE(SUM((p->>'amount')::bigint), 0) FROM jsonb_array_elements(se.after->'payments') p)  AS new_paid
    FROM sale_order_edits se
    JOIN sale_orders so ON so.id = se.order_id
    WHERE se.edited_at >= now() - interval '90 days'
  ) diff
  LEFT JOIN profiles pr ON pr.id = diff.edited_by
  WHERE diff.new_total < diff.old_total
     OR diff.new_discount > diff.old_discount
     OR diff.new_paid < diff.old_paid;

END;
$$;

GRANT EXECUTE ON FUNCTION run_display_checks(uuid) TO service_role;
