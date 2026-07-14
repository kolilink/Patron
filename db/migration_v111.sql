-- ============================================================
-- Patron — Migration v111
-- Run in Supabase SQL Editor AFTER migration_v110
--
-- Adds 8 display-accuracy checks (69–76) to the nightly
-- reconciliation system. These specifically target the
-- correctness of numbers shown in the Rapports screen.
--
-- Two new functions:
--   run_display_checks(p_run_id)       — inserts checks 69–76
--                                        into an existing run
--   refresh_reconciliation_run(p_run_id) — recalculates run
--                                        totals after appending
--
-- The nightly Edge Function calls both AFTER run_reconciliation().
-- ============================================================

-- ─── 1. run_display_checks ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION run_display_checks(p_run_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN

  -- ── Check 69: Orders missing sale_date ───────────────────────────────────
  -- get_reports_snapshot filters by sale_date. A NULL sale_date causes the
  -- sale to be excluded entirely from period calculations (period filter
  -- evaluates to unknown). Any row with NULL here is invisible in Rapports.
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
  -- The all-time cash formula: payments + injections − expenses − supplier_payments
  -- − investor_payouts. More than 100 000 GNF negative almost certainly means
  -- a missing capital injection or a phantom expense, not a legitimate overdraft.
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
  -- Perte moves are deducted from profit via stock_losses in get_reports_snapshot.
  -- If the product's cost_price is 0 at the time, that deduction is 0 — the loss
  -- costs nothing and profit is overstated by the true replacement cost.
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
  -- receive_purchase_order() auto-creates transport_achat expenses linked to the PO.
  -- A transport_achat WITHOUT a PO link was entered manually. It may represent a
  -- legitimate extra shipping cost, but it could also double-count shipping already
  -- baked into cost_price via AVCO on that PO. Flag for founder review.
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
  -- The confirm_payout RPC should guard against overpaying, but a direct INSERT
  -- into investor_payouts bypasses it. A negative balance shows up as negative
  -- investor equity in the Rapports screen.
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
  -- At the business level for the last 30 days, sum(order.total_amount − discount)
  -- must equal sum(line.unit_price × qty) across non-cancelled non-system orders.
  -- A sustained gap means some orders were partially written (lines saved, header
  -- not updated, or vice versa) and Rapports shows an inflated or deflated revenue.
  INSERT INTO reconciliation_findings
    (run_id, check_id, domain, check_name, severity,
     business_id, detail, affected_count)
  SELECT
    p_run_id, 74, 'Affichage', 'Écart revenu commandes vs lignes (30 jours)', 'warning',
    agg.business_id,
    format('Boutique %s: total commandes (%s GNF×100) ≠ total lignes (%s GNF×100) — écart %s centimes',
      agg.business_id, agg.order_total, agg.lines_total, ABS(agg.order_total - agg.lines_total)),
    1
  FROM (
    SELECT
      so.business_id,
      SUM(so.total_amount - COALESCE(so.discount_amount, 0))         AS order_total,
      SUM(sl.unit_price * sl.qty) - COALESCE(SUM(DISTINCT so.discount_amount), 0) AS lines_total
    FROM sale_orders so
    JOIN so_lines sl ON sl.order_id = so.id
    LEFT JOIN products p ON p.id = sl.product_id
    WHERE so.status IN ('paye', 'credit')
      AND so.sale_date >= CURRENT_DATE - 30
      AND NOT COALESCE(p.is_system, false)
    GROUP BY so.business_id
    HAVING ABS(
      SUM(so.total_amount - COALESCE(so.discount_amount, 0))
      - (SUM(sl.unit_price * sl.qty) - COALESCE(SUM(DISTINCT so.discount_amount), 0))
    ) > 10000 -- 100 GNF tolerance for rounding across many orders
  ) agg;

  -- ── Check 75: Credit negative per order ──────────────────────────────────
  -- Each credit sale's outstanding = total - discount - payments_received.
  -- If payments_received > net_amount, the sum shown in Rapports becomes negative,
  -- inflating "credit à encaisser" the wrong way.
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
  -- A negative cost_price flips the sign of COGS and stock value calculations —
  -- every unit sold would *add* to profit instead of reducing it. The stock value
  -- shown in Rapports would also be negative for those products.
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

END;
$$;

GRANT EXECUTE ON FUNCTION run_display_checks(uuid) TO service_role;


-- ─── 2. refresh_reconciliation_run ───────────────────────────────────────────
-- Called after run_display_checks() to recompute the run summary totals.
-- run_reconciliation() finalises the run before it returns. Appending more
-- findings via run_display_checks() makes those summary counts stale, so
-- we refresh them here before the Edge Function reads the final state.

CREATE OR REPLACE FUNCTION refresh_reconciliation_run(p_run_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE reconciliation_runs SET
    total_findings = (
      SELECT COUNT(*) FROM reconciliation_findings WHERE run_id = p_run_id
    ),
    critical_count = (
      SELECT COUNT(*) FROM reconciliation_findings
      WHERE run_id = p_run_id AND severity = 'critical'
    ),
    warning_count  = (
      SELECT COUNT(*) FROM reconciliation_findings
      WHERE run_id = p_run_id AND severity = 'warning'
    ),
    status = CASE
      WHEN (SELECT COUNT(*) FROM reconciliation_findings
            WHERE run_id = p_run_id AND severity = 'critical') > 0 THEN 'findings'
      WHEN (SELECT COUNT(*) FROM reconciliation_findings
            WHERE run_id = p_run_id AND severity = 'warning')  > 0 THEN 'findings'
      ELSE 'clean'
    END,
    completed_at = now()
  WHERE id = p_run_id;
$$;

GRANT EXECUTE ON FUNCTION refresh_reconciliation_run(uuid) TO service_role;
