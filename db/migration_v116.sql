-- ============================================================
-- Patron — Migration v116
-- Run in Supabase SQL Editor AFTER migration_v115
--
-- migration_v115 added edit_injection() and record_withdrawal()
-- for capital_injections (admin/manager only). This adds two
-- matching reconciliation checks (77-78) so the nightly report
-- catches misuse and gives the founder visibility on these
-- money-sensitive manual overrides — the same way check #72
-- already flags manual transport_achat entries for review.
--
--   Check 77 (critical): a contributor's net capital position
--     (SUM of their own capital_injections rows, apports minus
--     retraits) has gone negative — meaning more was recorded as
--     withdrawn than that person/source ever contributed. This
--     should never legitimately happen.
--
--   Check 78 (warning): any capital_injections row was edited via
--     edit_injection() or a withdrawal was recorded via
--     record_withdrawal() in the last 90 days — informational
--     visibility for the founder, since these bypass the normal
--     insert-only flow.
-- ============================================================

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
  -- A withdrawal (negative capital_injections row, added in v115) reduced a
  -- specific contributor's running total below zero — more was recorded as
  -- taken out than that person/source ever put in. Should never happen;
  -- almost certainly a data-entry mistake by the manager/admin who recorded it.
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
  -- Visibility only (not necessarily an error) — edit_injection() and
  -- record_withdrawal() (v115) are manual overrides restricted to
  -- admin/manager. Surface them nightly the same way check #72 surfaces
  -- manual transport_achat entries, so the founder can spot-check.
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

END;
$$;

GRANT EXECUTE ON FUNCTION run_display_checks(uuid) TO service_role;
