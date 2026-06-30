-- ============================================================
-- Patron — Migration v99
-- Run in Supabase SQL Editor AFTER migration_v98
--
-- Adds the nightly reconciliation system:
--   • reconciliation_runs   — one row per nightly audit run
--   • reconciliation_findings — one row per violation found
--   • run_reconciliation()  — SECURITY DEFINER function that
--     executes all 68 checks and populates both tables.
--
-- Called nightly by the send-reconciliation-report Edge Function,
-- which emails the results to the founder via Resend.
-- Safe to re-run (uses CREATE OR REPLACE / IF NOT EXISTS).
-- ============================================================

-- ─── 1. Tables ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  total_findings  INTEGER     NOT NULL DEFAULT 0,
  critical_count  INTEGER     NOT NULL DEFAULT 0,
  warning_count   INTEGER     NOT NULL DEFAULT 0,
  businesses_checked INTEGER  NOT NULL DEFAULT 0,
  status          TEXT        NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','clean','findings','error')),
  error_detail    TEXT
);

CREATE TABLE IF NOT EXISTS reconciliation_findings (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id         UUID        NOT NULL REFERENCES reconciliation_runs(id) ON DELETE CASCADE,
  check_id       INTEGER     NOT NULL,
  domain         TEXT        NOT NULL,
  check_name     TEXT        NOT NULL,
  severity       TEXT        NOT NULL CHECK (severity IN ('critical','warning')),
  business_id    UUID        REFERENCES businesses(id),
  entity_type    TEXT,
  entity_id      UUID,
  detail         TEXT        NOT NULL,
  affected_count INTEGER     NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS recon_findings_run
  ON reconciliation_findings(run_id);
CREATE INDEX IF NOT EXISTS recon_findings_severity
  ON reconciliation_findings(run_id, severity);
CREATE INDEX IF NOT EXISTS recon_findings_domain
  ON reconciliation_findings(run_id, domain);

ALTER TABLE reconciliation_runs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_findings ENABLE ROW LEVEL SECURITY;

-- Only the service role (Edge Function) can touch these tables.
DROP POLICY IF EXISTS "no_user_access_runs"     ON reconciliation_runs;
DROP POLICY IF EXISTS "no_user_access_findings" ON reconciliation_findings;
CREATE POLICY "no_user_access_runs"     ON reconciliation_runs     FOR ALL USING (false);
CREATE POLICY "no_user_access_findings" ON reconciliation_findings FOR ALL USING (false);

-- ─── 2. run_reconciliation() ─────────────────────────────────

CREATE OR REPLACE FUNCTION run_reconciliation()
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run_id UUID;
  v_biz_count INTEGER;
BEGIN
  -- Open the run record
  INSERT INTO reconciliation_runs DEFAULT VALUES RETURNING id INTO v_run_id;
  SELECT COUNT(*) INTO v_biz_count FROM businesses;

  -- ============================================================
  -- DOMAIN 1 — STOCK  (checks 1–8)
  -- ============================================================

  -- 1. Confirmed sale missing a 'sortie' stock_move
  --    submit_sale always inserts a stock_move (type='sortie', ref_id=sale_order.id)
  --    for every so_line. If one is missing, stock was never decremented.
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,1,'Stock','Sortie stock manquante pour vente confirmée',
    'critical', so.business_id,'sale_order',so.id,
    'Vente #'||LEFT(so.id::TEXT,8)||' ('||so.status||'): '||COUNT(sl.id)||
    ' ligne(s) sans mouvement de stock "sortie" correspondant',
    COUNT(sl.id)::INT
  FROM sale_orders so
  JOIN so_lines sl ON sl.order_id = so.id
  WHERE so.status IN ('paye','credit')
    AND NOT EXISTS (
      SELECT 1 FROM stock_moves sm
      WHERE sm.ref_id = so.id AND sm.type = 'sortie' AND sm.product_id = sl.product_id
    )
  GROUP BY so.business_id, so.id, so.status
  HAVING COUNT(sl.id) > 0;

  -- 2. Sortie qty in stock_moves does not match so_lines qty
  --    Per-product aggregate: the total 'sortie' qty for a sale should equal the line qty.
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,2,'Stock','Quantité sortie ≠ quantité vendue',
    'critical', so.business_id,'sale_order',so.id,
    'Vente #'||LEFT(so.id::TEXT,8)||' produit "'||COALESCE(sl.product_name,sl.product_id::TEXT)||
    '": so_lines.qty='||sl.qty||' mais stock_moves.qty='||COALESCE(sm_agg.total,0),
    1
  FROM sale_orders so
  JOIN so_lines sl ON sl.order_id = so.id
  LEFT JOIN (
    SELECT ref_id, product_id, SUM(qty) AS total
    FROM stock_moves WHERE type = 'sortie'
    GROUP BY ref_id, product_id
  ) sm_agg ON sm_agg.ref_id = so.id AND sm_agg.product_id = sl.product_id
  WHERE so.status IN ('paye','credit')
    AND sl.qty != COALESCE(sm_agg.total, 0);

  -- 3. Cancelled sale missing stock restoration ('entree' with ref_type='annulation')
  --    v96 fixed cancel_sale to always create this entry. If missing, stock was lost.
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,3,'Stock','Restauration stock manquante pour vente annulée',
    'critical', so.business_id,'sale_order',so.id,
    'Vente annulée #'||LEFT(so.id::TEXT,8)||': '||COUNT(sl.id)||
    ' ligne(s) sans mouvement de restauration — stock définitivement perdu',
    COUNT(sl.id)::INT
  FROM sale_orders so
  JOIN so_lines sl ON sl.order_id = so.id
  WHERE so.status = 'annule'
    AND sl.cost_price_at_sale IS NOT NULL   -- only lines confirmed post-v81 had stock properly moved
    AND NOT EXISTS (
      SELECT 1 FROM stock_moves sm
      WHERE sm.ref_id = so.id
        AND sm.type = 'entree'
        AND sm.product_id = sl.product_id
    )
  GROUP BY so.business_id, so.id
  HAVING COUNT(sl.id) > 0;

  -- 4. Restoration qty does not match original sale qty
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,4,'Stock','Quantité restaurée ≠ quantité vendue initialement',
    'critical', so.business_id,'sale_order',so.id,
    'Vente annulée #'||LEFT(so.id::TEXT,8)||' produit "'||COALESCE(sl.product_name,sl.product_id::TEXT)||
    '": vendu='||sl.qty||' restauré='||COALESCE(sm_agg.total,0)||
    ' (écart='||(sl.qty - COALESCE(sm_agg.total,0))||')',
    1
  FROM sale_orders so
  JOIN so_lines sl ON sl.order_id = so.id
  JOIN (
    SELECT ref_id, product_id, SUM(qty) AS total
    FROM stock_moves WHERE type = 'entree'
    GROUP BY ref_id, product_id
  ) sm_agg ON sm_agg.ref_id = so.id AND sm_agg.product_id = sl.product_id
  WHERE so.status = 'annule'
    AND sl.cost_price_at_sale IS NOT NULL
    AND sl.qty != sm_agg.total;

  -- 5. Product stock negative (products without variants)
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,5,'Stock','Stock produit négatif',
    'critical', p.business_id,'product',p.id,
    'Produit "'||p.name||'": stock_qty='||p.stock_qty||' (négatif — vente sans stock disponible)',
    1
  FROM products p WHERE p.stock_qty < 0;

  -- 6. Variant stock negative
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,6,'Stock','Stock variante négatif',
    'critical', p.business_id,'product_variant',pv.id,
    'Variante "'||pv.name||'" (produit "'||p.name||'"): stock_qty='||pv.stock_qty||' (négatif)',
    1
  FROM product_variants pv
  JOIN products p ON p.id = pv.product_id
  WHERE pv.stock_qty < 0;

  -- 7. Parent product stock ≠ sum of its variant stocks
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,7,'Stock','Stock parent ≠ somme des variantes',
    'critical', p.business_id,'product',p.id,
    'Produit "'||p.name||'": stock_qty='||p.stock_qty||
    ' mais ∑ variantes='||var_sum.total||
    ' (écart='||(p.stock_qty - var_sum.total)||')',
    1
  FROM products p
  JOIN (
    SELECT product_id, SUM(stock_qty) AS total
    FROM product_variants GROUP BY product_id
  ) var_sum ON var_sum.product_id = p.id
  WHERE p.stock_qty != var_sum.total;

  -- 8. PO receipt: received qty across po_lines does not have matching 'entree' stock_moves
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,8,'Stock','Réception commande sans mouvement de stock entrant',
    'warning', po.business_id,'purchase_order',po.id,
    'Commande #'||LEFT(po.id::TEXT,8)||': '||COUNT(pol.id)||
    ' ligne(s) reçue(s) sans "entree" stock_move correspondant',
    COUNT(pol.id)::INT
  FROM purchase_orders po
  JOIN po_lines pol ON pol.po_id = po.id
  WHERE po.status IN ('recu','recu_partiel')
    AND pol.qty_received > 0
    AND NOT EXISTS (
      SELECT 1 FROM stock_moves sm
      WHERE sm.ref_id = po.id AND sm.type = 'entree' AND sm.product_id = pol.product_id
    )
  GROUP BY po.business_id, po.id
  HAVING COUNT(pol.id) > 0;

  -- ============================================================
  -- DOMAIN 2 — SALE ORDER INTEGRITY  (checks 9–15)
  -- ============================================================

  -- 9. Sale total ≠ sum of line items
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,9,'Ventes','Total vente ≠ somme des lignes',
    'critical', so.business_id,'sale_order',so.id,
    'Vente #'||LEFT(so.id::TEXT,8)||': total_amount='||so.total_amount||
    ' mais ∑(qty×unit_price)='||COALESCE(ls.total,0)||
    ' (écart='||(so.total_amount - COALESCE(ls.total,0))||')',
    1
  FROM sale_orders so
  LEFT JOIN (
    SELECT order_id, SUM(qty * unit_price) AS total FROM so_lines GROUP BY order_id
  ) ls ON ls.order_id = so.id
  WHERE so.status IN ('paye','credit','annule')
    AND so.total_amount != COALESCE(ls.total, 0);

  -- 10. Confirmed sale has no lines at all
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,10,'Ventes','Vente confirmée sans aucune ligne',
    'critical', so.business_id,'sale_order',so.id,
    'Vente #'||LEFT(so.id::TEXT,8)||' (statut: '||so.status||
    '): aucune so_line — stock jamais touché, CA jamais enregistré',
    1
  FROM sale_orders so
  WHERE so.status IN ('paye','credit','annule')
    AND NOT EXISTS (SELECT 1 FROM so_lines sl WHERE sl.order_id = so.id);

  -- 11. Discount >= total (impossible)
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,11,'Ventes','Remise ≥ montant total',
    'critical', so.business_id,'sale_order',so.id,
    'Vente #'||LEFT(so.id::TEXT,8)||': discount_amount='||so.discount_amount||
    ' >= total_amount='||so.total_amount||' (net payable ≤ 0)',
    1
  FROM sale_orders so
  WHERE so.discount_amount >= so.total_amount
    AND so.discount_amount > 0
    AND so.status NOT IN ('brouillon');

  -- 12. Orphan so_lines (sale_order deleted — FK should prevent, verify anyway)
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,12,'Ventes','Lignes de vente orphelines',
    'critical', NULL,'so_line',sl.id,
    'so_line #'||LEFT(sl.id::TEXT,8)||': order_id='||sl.order_id||' introuvable',
    1
  FROM so_lines sl
  WHERE NOT EXISTS (SELECT 1 FROM sale_orders so WHERE so.id = sl.order_id);

  -- 13. so_lines referencing a deleted product
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,13,'Ventes','Ligne de vente avec produit supprimé',
    'critical', so.business_id,'so_line',sl.id,
    'Ligne #'||LEFT(sl.id::TEXT,8)||' (vente '||LEFT(so.id::TEXT,8)||
    '): product_id='||sl.product_id||' introuvable',
    1
  FROM so_lines sl
  JOIN sale_orders so ON so.id = sl.order_id
  WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.id = sl.product_id);

  -- 14. product_name missing on recent confirmed sales
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,14,'Ventes','Instantané nom produit manquant',
    'warning', so.business_id,'sale_order',so.id,
    'Vente #'||LEFT(so.id::TEXT,8)||': '||COUNT(sl.id)||
    ' ligne(s) sans product_name — historique ventes incomplet',
    COUNT(sl.id)::INT
  FROM sale_orders so
  JOIN so_lines sl ON sl.order_id = so.id
  WHERE sl.product_name IS NULL
    AND so.status IN ('paye','credit')
    AND so.created_at > '2024-01-01'
  GROUP BY so.business_id, so.id
  HAVING COUNT(sl.id) > 0;

  -- 15. Duplicate idempotency keys for non-cancelled sales
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,15,'Ventes','Clé idempotence dupliquée',
    'critical', so.business_id,'sale_order',MIN(so.id::text)::uuid,
    'Clé '||so.idempotency_key||': '||COUNT(so.id)||
    ' ventes avec la même clé (vente enregistrée plusieurs fois)',
    COUNT(so.id)::INT
  FROM sale_orders so
  WHERE so.idempotency_key IS NOT NULL
    AND so.status != 'annule'
  GROUP BY so.business_id, so.idempotency_key
  HAVING COUNT(so.id) > 1;

  -- ============================================================
  -- DOMAIN 3 — PAYMENTS  (checks 16–22)
  -- ============================================================

  -- 16. Paid sale: payments don't sum to net amount
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,16,'Paiements','Vente "paye" non entièrement couverte',
    'critical', so.business_id,'sale_order',so.id,
    'Vente #'||LEFT(so.id::TEXT,8)||': net dû='||
    (so.total_amount - so.discount_amount)||
    ' paiements reçus='||COALESCE(ps.total,0)||
    ' (écart='||((so.total_amount - so.discount_amount) - COALESCE(ps.total,0))||')',
    1
  FROM sale_orders so
  LEFT JOIN (
    SELECT order_id, SUM(amount) AS total FROM payments GROUP BY order_id
  ) ps ON ps.order_id = so.id
  WHERE so.status = 'paye'
    AND COALESCE(ps.total, 0) < (so.total_amount - so.discount_amount);

  -- 17. Credit sale fully paid but not marked 'paye'
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,17,'Paiements','Crédit soldé mais non clôturé',
    'warning', so.business_id,'sale_order',so.id,
    'Vente crédit #'||LEFT(so.id::TEXT,8)||': net dû='||
    (so.total_amount - so.discount_amount)||
    ' paiements reçus='||ps.total||
    ' — devrait être marquée "paye"',
    1
  FROM sale_orders so
  JOIN (
    SELECT order_id, SUM(amount) AS total FROM payments GROUP BY order_id
  ) ps ON ps.order_id = so.id
  WHERE so.status = 'credit'
    AND ps.total >= (so.total_amount - so.discount_amount);

  -- 18. Payments exist on a cancelled sale
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,18,'Paiements','Paiement sur vente annulée',
    'critical', so.business_id,'sale_order',so.id,
    'Vente annulée #'||LEFT(so.id::TEXT,8)||': '||COUNT(p.id)||
    ' paiement(s) pour '||SUM(p.amount)||' — argent comptabilisé pour transaction inexistante',
    COUNT(p.id)::INT
  FROM sale_orders so
  JOIN payments p ON p.order_id = so.id
  WHERE so.status = 'annule'
  GROUP BY so.business_id, so.id;

  -- 19. Payments exist on a draft order
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,19,'Paiements','Paiement sur brouillon non confirmé',
    'critical', so.business_id,'sale_order',so.id,
    'Brouillon #'||LEFT(so.id::TEXT,8)||': '||COUNT(p.id)||
    ' paiement(s) sur vente jamais confirmée',
    COUNT(p.id)::INT
  FROM sale_orders so
  JOIN payments p ON p.order_id = so.id
  WHERE so.status = 'brouillon'
  GROUP BY so.business_id, so.id;

  -- 20. Payment amount is zero or negative
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,20,'Paiements','Montant de paiement nul ou négatif',
    'critical', so.business_id,'payment',p.id,
    'Paiement #'||LEFT(p.id::TEXT,8)||
    ' (vente '||LEFT(p.order_id::TEXT,8)||'): amount='||p.amount||' (invalide)',
    1
  FROM payments p
  JOIN sale_orders so ON so.id = p.order_id
  WHERE p.amount <= 0;

  -- 21. Orphan payments (sale deleted — should not happen with FK cascade)
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,21,'Paiements','Paiement sans vente associée',
    'critical', NULL,'payment',p.id,
    'Paiement #'||LEFT(p.id::TEXT,8)||': order_id='||p.order_id||' introuvable',
    1
  FROM payments p
  WHERE NOT EXISTS (SELECT 1 FROM sale_orders so WHERE so.id = p.order_id);

  -- 22. Payments on a credit sale exceed the amount owed
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,22,'Paiements','Surpaiement sur crédit',
    'critical', so.business_id,'sale_order',so.id,
    'Vente crédit #'||LEFT(so.id::TEXT,8)||': net dû='||
    (so.total_amount - so.discount_amount)||
    ' paiements='||ps.total||
    ' surplus='||(ps.total - (so.total_amount - so.discount_amount)),
    1
  FROM sale_orders so
  JOIN (
    SELECT order_id, SUM(amount) AS total FROM payments GROUP BY order_id
  ) ps ON ps.order_id = so.id
  WHERE so.status = 'credit'
    AND ps.total > (so.total_amount - so.discount_amount);

  -- ============================================================
  -- DOMAIN 4 — COGS ET COÛT DE REVIENT  (checks 23–26)
  -- ============================================================

  -- 23. cost_price_at_sale NULL on confirmed sales where product has a known cost
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,23,'COGS','Coût de revient non capturé',
    'critical', so.business_id,'sale_order',so.id,
    'Vente #'||LEFT(so.id::TEXT,8)||': '||COUNT(sl.id)||
    ' ligne(s) sans cost_price_at_sale — profit sur ces ventes surestimé à 100%',
    COUNT(sl.id)::INT
  FROM sale_orders so
  JOIN so_lines sl ON sl.order_id = so.id
  JOIN products p ON p.id = sl.product_id
  WHERE so.status IN ('paye','credit')
    AND sl.cost_price_at_sale IS NULL
    AND p.cost_price > 0
  GROUP BY so.business_id, so.id
  HAVING COUNT(sl.id) > 0;

  -- 24. cost_price_at_sale is negative (impossible)
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,24,'COGS','Coût de revient négatif',
    'critical', so.business_id,'so_line',sl.id,
    'Ligne #'||LEFT(sl.id::TEXT,8)||' (vente '||LEFT(so.id::TEXT,8)||
    '): cost_price_at_sale='||sl.cost_price_at_sale||' (valeur négative impossible)',
    1
  FROM so_lines sl
  JOIN sale_orders so ON so.id = sl.order_id
  WHERE sl.cost_price_at_sale < 0;

  -- 25. cost_price_at_sale = 0 on a confirmed sale (suspicious, may be real)
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,25,'COGS','Lignes de vente à coût zéro',
    'warning', so.business_id,'sale_order',so.id,
    'Vente #'||LEFT(so.id::TEXT,8)||': '||COUNT(sl.id)||
    ' ligne(s) avec cost_price_at_sale=0 — vérifier si intentionnel',
    COUNT(sl.id)::INT
  FROM sale_orders so
  JOIN so_lines sl ON sl.order_id = so.id
  WHERE so.status IN ('paye','credit')
    AND sl.cost_price_at_sale = 0
  GROUP BY so.business_id, so.id
  HAVING COUNT(sl.id) > 0;

  -- 26. COGS > net revenue on a single sale (selling at a loss)
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,26,'COGS','Vente à perte',
    'warning', so.business_id,'sale_order',so.id,
    'Vente #'||LEFT(so.id::TEXT,8)||': COGS='||cogs.total||
    ' > net='||(so.total_amount - so.discount_amount)||
    ' (perte='||(cogs.total - (so.total_amount - so.discount_amount))||')',
    1
  FROM sale_orders so
  JOIN (
    SELECT order_id, SUM(qty * cost_price_at_sale) AS total
    FROM so_lines WHERE cost_price_at_sale IS NOT NULL
    GROUP BY order_id
  ) cogs ON cogs.order_id = so.id
  WHERE so.status IN ('paye','credit')
    AND cogs.total > (so.total_amount - so.discount_amount);

  -- ============================================================
  -- DOMAIN 5 — DÉPENSES  (checks 27–30)
  -- ============================================================

  -- 27. Expense amount is zero or negative
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,27,'Dépenses','Montant de dépense nul ou négatif',
    'critical', e.business_id,'expense',e.id,
    'Dépense #'||LEFT(e.id::TEXT,8)||': amount='||e.amount||' (invalide)',
    1
  FROM expenses e WHERE e.amount <= 0;

  -- 28. Expense with invalid status value
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,28,'Dépenses','Statut dépense invalide',
    'critical', e.business_id,'expense',e.id,
    'Dépense #'||LEFT(e.id::TEXT,8)||': statut="'||e.status||'" non reconnu',
    1
  FROM expenses e
  WHERE e.status NOT IN ('en_attente','approuve','rejete');

  -- 29. Orphan expense (business deleted)
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,29,'Dépenses','Dépense sans boutique',
    'critical', e.business_id,'expense',e.id,
    'Dépense #'||LEFT(e.id::TEXT,8)||': business_id='||e.business_id||' introuvable',
    1
  FROM expenses e
  WHERE NOT EXISTS (SELECT 1 FROM businesses b WHERE b.id = e.business_id);

  -- 30. Boutique with ≥10 sales this month but zero approved expenses
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,30,'Dépenses','Boutique avec ventes mais aucune dépense ce mois',
    'warning', b.id,'business',b.id,
    'Boutique "'||b.name||'": '||sc.cnt||
    ' vente(s) ce mois, 0 dépense approuvée — sous-déclaration probable',
    sc.cnt
  FROM businesses b
  JOIN (
    SELECT business_id, COUNT(*) AS cnt
    FROM sale_orders
    WHERE status IN ('paye','credit')
      AND created_at >= DATE_TRUNC('month', CURRENT_DATE)
    GROUP BY business_id HAVING COUNT(*) >= 10
  ) sc ON sc.business_id = b.id
  WHERE NOT EXISTS (
    SELECT 1 FROM expenses e
    WHERE e.business_id = b.id
      AND e.status = 'approuve'
      AND e.created_at >= DATE_TRUNC('month', CURRENT_DATE)
  );

  -- ============================================================
  -- DOMAIN 6 — CRÉDIT / COMPTES CLIENTS  (checks 31–34)
  -- ============================================================

  -- 31. Outstanding credit balance is negative (customer overpaid)
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,31,'Crédit','Solde crédit négatif — surpaiement non traité',
    'critical', so.business_id,'sale_order',so.id,
    'Vente crédit #'||LEFT(so.id::TEXT,8)||
    ': solde=('||(so.total_amount - so.discount_amount)||
    ' - '||COALESCE(ps.total,0)||')='||
    ((so.total_amount - so.discount_amount) - COALESCE(ps.total,0))||' (négatif)',
    1
  FROM sale_orders so
  LEFT JOIN (
    SELECT order_id, SUM(amount) AS total FROM payments GROUP BY order_id
  ) ps ON ps.order_id = so.id
  WHERE so.status = 'credit'
    AND (so.total_amount - so.discount_amount) - COALESCE(ps.total,0) < 0;

  -- 32. Overdue credit (due_date passed, still unpaid)
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,32,'Crédit','Crédit en retard de paiement',
    'warning', so.business_id,'sale_order',so.id,
    'Vente crédit #'||LEFT(so.id::TEXT,8)||
    ': échéance='||so.due_date||
    ' client="'||COALESCE(c.name, so.customer_name, 'inconnu')||'"'||
    ' solde='||((so.total_amount - so.discount_amount) - COALESCE(ps.total,0)),
    1
  FROM sale_orders so
  LEFT JOIN clients c ON c.id = so.client_id
  LEFT JOIN (
    SELECT order_id, SUM(amount) AS total FROM payments GROUP BY order_id
  ) ps ON ps.order_id = so.id
  WHERE so.status = 'credit'
    AND so.due_date IS NOT NULL
    AND so.due_date < CURRENT_DATE
    AND (so.total_amount - so.discount_amount) - COALESCE(ps.total,0) > 0;

  -- 33. Credit sale with invalid client reference
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,33,'Crédit','Vente avec client inexistant',
    'warning', so.business_id,'sale_order',so.id,
    'Vente #'||LEFT(so.id::TEXT,8)||': client_id='||so.client_id||' introuvable',
    1
  FROM sale_orders so
  WHERE so.client_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM clients c WHERE c.id = so.client_id);

  -- 34. Revenue minus cash does not equal outstanding credit (global per-business check)
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,34,'Crédit','Solde crédit global incohérent',
    'critical', b.id,'business',b.id,
    'Boutique "'||b.name||'": (CA - encaissé)='||
    (COALESCE(rev.total,0) - COALESCE(cash.total,0))||
    ' ≠ crédit en attente='||COALESCE(credit_bal.total,0)||
    ' (écart='||ABS((COALESCE(rev.total,0) - COALESCE(cash.total,0)) - COALESCE(credit_bal.total,0))||')',
    1
  FROM businesses b
  LEFT JOIN (
    SELECT business_id, SUM(total_amount - discount_amount) AS total
    FROM sale_orders WHERE status IN ('paye','credit') GROUP BY business_id
  ) rev ON rev.business_id = b.id
  LEFT JOIN (
    SELECT so.business_id, SUM(p.amount) AS total
    FROM payments p JOIN sale_orders so ON so.id = p.order_id
    GROUP BY so.business_id
  ) cash ON cash.business_id = b.id
  LEFT JOIN (
    SELECT so.business_id,
      SUM((so.total_amount - so.discount_amount) - COALESCE(ps.total,0)) AS total
    FROM sale_orders so
    LEFT JOIN (
      SELECT order_id, SUM(amount) AS total FROM payments GROUP BY order_id
    ) ps ON ps.order_id = so.id
    WHERE so.status = 'credit'
    GROUP BY so.business_id
  ) credit_bal ON credit_bal.business_id = b.id
  WHERE ABS(
    (COALESCE(rev.total,0) - COALESCE(cash.total,0)) - COALESCE(credit_bal.total,0)
  ) > 0;

  -- ============================================================
  -- DOMAIN 7 — DETTES FOURNISSEURS  (checks 35–36)
  -- ============================================================

  -- 35. Supplier debt where amount_paid > amount (overpaid)
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,35,'Fournisseurs','Surpaiement fournisseur',
    'warning', sd.business_id,'supplier_debt',sd.id,
    'Dette fournisseur #'||LEFT(sd.id::TEXT,8)||
    ': montant='||sd.amount||' amount_paid='||sd.amount_paid||
    ' (surplus='||(sd.amount_paid - sd.amount)||')',
    1
  FROM supplier_debts sd WHERE sd.amount_paid > sd.amount;

  -- 36. Supplier debt referencing a deleted supplier
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,36,'Fournisseurs','Dette sans fournisseur valide',
    'critical', sd.business_id,'supplier_debt',sd.id,
    'Dette #'||LEFT(sd.id::TEXT,8)||': supplier_id='||sd.supplier_id||' introuvable',
    1
  FROM supplier_debts sd
  WHERE NOT EXISTS (SELECT 1 FROM suppliers s WHERE s.id = sd.supplier_id);

  -- ============================================================
  -- DOMAIN 8 — COMMANDES FOURNISSEURS  (checks 37–40)
  -- ============================================================

  -- 37. qty_received > qty_ordered on a PO line
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,37,'Commandes','Quantité reçue > quantité commandée',
    'critical', po.business_id,'purchase_order',po.id,
    'Commande #'||LEFT(po.id::TEXT,8)||' produit "'||COALESCE(p.name,pol.product_id::TEXT)||
    '": reçu='||pol.qty_received||' > commandé='||pol.qty_ordered,
    1
  FROM po_lines pol
  JOIN purchase_orders po ON po.id = pol.po_id
  LEFT JOIN products p ON p.id = pol.product_id
  WHERE pol.qty_received > pol.qty_ordered;

  -- 38. PO status inconsistent with received quantities
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,38,'Commandes','Statut commande incohérent avec réception',
    'warning', po.business_id,'purchase_order',po.id,
    'Commande #'||LEFT(po.id::TEXT,8)||': statut="'||po.status||'" mais '||
    CASE
      WHEN tot.rcvd = tot.ord THEN 'tout reçu → devrait être "recu"'
      WHEN tot.rcvd > 0 AND tot.rcvd < tot.ord THEN 'partiel → devrait être "recu_partiel"'
      ELSE 'rien reçu → devrait être "brouillon" ou "envoye"'
    END,
    1
  FROM purchase_orders po
  JOIN (
    SELECT po_id, SUM(qty_ordered) AS ord, SUM(qty_received) AS rcvd
    FROM po_lines GROUP BY po_id
  ) tot ON tot.po_id = po.id
  WHERE po.status NOT IN ('annule') AND (
    (tot.rcvd = tot.ord AND po.status != 'recu')
    OR (tot.rcvd > 0 AND tot.rcvd < tot.ord AND po.status != 'recu_partiel')
    OR (tot.rcvd = 0 AND po.status IN ('recu','recu_partiel'))
  );

  -- 39. PO line referencing a deleted product
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,39,'Commandes','Ligne de commande avec produit inexistant',
    'critical', po.business_id,'purchase_order',po.id,
    'Commande #'||LEFT(po.id::TEXT,8)||': product_id='||pol.product_id||' introuvable',
    1
  FROM po_lines pol
  JOIN purchase_orders po ON po.id = pol.po_id
  WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.id = pol.product_id);

  -- 40. qty_received is negative on any PO line
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,40,'Commandes','Quantité reçue négative',
    'critical', po.business_id,'purchase_order',po.id,
    'Commande #'||LEFT(po.id::TEXT,8)||': qty_received='||pol.qty_received||' (négatif)',
    1
  FROM po_lines pol
  JOIN purchase_orders po ON po.id = pol.po_id
  WHERE pol.qty_received < 0;

  -- ============================================================
  -- DOMAIN 9 — INTÉGRITÉ PRODUITS  (checks 41–45)
  -- ============================================================

  -- 41. Active product with zero or negative sale price
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,41,'Produits','Prix de vente nul ou négatif',
    'critical', p.business_id,'product',p.id,
    'Produit actif "'||p.name||'": sale_price='||p.sale_price||
    ' — toute vente enregistre un CA de 0',
    1
  FROM products p
  WHERE p.sale_price <= 0 AND p.archived = false AND p.is_system = false;

  -- 42. Cost price exceeds sale price (guaranteed loss on every sale)
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,42,'Produits','Coût de revient > prix de vente',
    'warning', p.business_id,'product',p.id,
    'Produit "'||p.name||'": cost_price='||p.cost_price||
    ' > sale_price='||p.sale_price||' (vente à perte systématique)',
    1
  FROM products p
  WHERE p.cost_price > p.sale_price
    AND p.archived = false AND p.cost_price > 0;

  -- 43. Bulk price >= unit price (backwards — bulk should be cheaper)
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,43,'Produits','Prix gros ≥ prix unitaire',
    'warning', p.business_id,'product',p.id,
    'Produit "'||p.name||'": bulk_price='||p.bulk_price||
    ' >= sale_price='||p.sale_price||' (le gros devrait coûter moins cher)',
    1
  FROM products p
  WHERE p.bulk_price IS NOT NULL
    AND p.bulk_price >= p.sale_price
    AND p.archived = false;

  -- 44. Archived product still has open credit sales
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,44,'Produits','Produit archivé avec crédit non soldé',
    'warning', p.business_id,'product',p.id,
    'Produit archivé "'||p.name||'": '||COUNT(DISTINCT so.id)||
    ' vente(s) crédit encore ouvertes',
    COUNT(DISTINCT so.id)::INT
  FROM products p
  JOIN so_lines sl ON sl.product_id = p.id
  JOIN sale_orders so ON so.id = sl.order_id
  WHERE p.archived = true AND so.status = 'credit'
  GROUP BY p.business_id, p.id, p.name;

  -- 45. Active product with null or empty name
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,45,'Produits','Produit sans nom',
    'warning', p.business_id,'product',p.id,
    'Produit #'||LEFT(p.id::TEXT,8)||': name vide ou nul',
    1
  FROM products p
  WHERE (p.name IS NULL OR TRIM(p.name) = '') AND p.archived = false;

  -- ============================================================
  -- DOMAIN 10 — PRÉCISION MONÉTAIRE  (checks 46–48)
  -- ============================================================

  -- 46. Sale price suspiciously small (×100 multiplication forgotten?)
  --     In BIGINT-cents convention, 1 unit of currency = 100.
  --     A sale_price < 100 means < 1 currency unit — almost never intentional.
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,46,'Montants','Prix de vente anormalement bas (×100 oublié ?)',
    'warning', p.business_id,'product',p.id,
    'Produit "'||p.name||'": sale_price='||p.sale_price||
    ' centimes ('||(p.sale_price/100.0)||' unité) — vérifier multiplication ×100',
    1
  FROM products p
  WHERE p.sale_price > 0 AND p.sale_price < 100
    AND p.archived = false AND p.is_system = false;

  -- 47. Single sale amount > 10 billion units (data entry error likely)
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,47,'Montants','Montant vente anormalement élevé',
    'warning', so.business_id,'sale_order',so.id,
    'Vente #'||LEFT(so.id::TEXT,8)||': total_amount='||so.total_amount||
    ' ('||(so.total_amount/100)||' unités) — possible erreur de saisie',
    1
  FROM sale_orders so
  WHERE so.total_amount > 1000000000000   -- > 10 milliards unités
    AND so.status IN ('paye','credit');

  -- 48. Single expense amount > 10 billion units
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,48,'Montants','Dépense anormalement élevée',
    'warning', e.business_id,'expense',e.id,
    'Dépense #'||LEFT(e.id::TEXT,8)||': amount='||e.amount||
    ' ('||(e.amount/100)||' unités) — possible erreur de saisie',
    1
  FROM expenses e WHERE e.amount > 1000000000000;

  -- ============================================================
  -- DOMAIN 11 — MEMBRES ET RÔLES  (checks 49–52)
  -- ============================================================

  -- 49. Business does not have exactly one administrateur
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,49,'Membres','Boutique sans administrateur unique',
    'critical', b.id,'business',b.id,
    'Boutique "'||b.name||'": '||COALESCE(ac.cnt,0)||
    ' administrateur(s) (exactement 1 requis)',
    1
  FROM businesses b
  LEFT JOIN (
    SELECT business_id, COUNT(*) AS cnt FROM memberships
    WHERE role = 'administrateur' GROUP BY business_id
  ) ac ON ac.business_id = b.id
  WHERE COALESCE(ac.cnt,0) != 1;

  -- 50. Business has more than one manager
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,50,'Membres','Plus d''un manager',
    'critical', m.business_id,'business',m.business_id,
    'Boutique '||LEFT(m.business_id::TEXT,8)||': '||COUNT(m.id)||' managers (max 1)',
    COUNT(m.id)::INT
  FROM memberships m
  WHERE m.role = 'manager'
  GROUP BY m.business_id HAVING COUNT(m.id) > 1;

  -- 51. Membership with an unrecognised role value
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,51,'Membres','Rôle invalide',
    'critical', m.business_id,'membership',m.id,
    'Membership #'||LEFT(m.id::TEXT,8)||': rôle="'||m.role||'" non reconnu',
    1
  FROM memberships m
  WHERE m.role NOT IN ('administrateur','manager','vendeur','investisseur');

  -- 52. Membership references a user with no profile
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,52,'Membres','Membre sans profil utilisateur',
    'critical', m.business_id,'membership',m.id,
    'Membership #'||LEFT(m.id::TEXT,8)||': user_id='||m.user_id||' sans profil',
    1
  FROM memberships m
  WHERE NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = m.user_id);

  -- ============================================================
  -- DOMAIN 12 — AGRÉGATS CROISÉS  (checks 53–57)
  -- ============================================================

  -- 53. Total payments in payments table ≠ sum via sale_orders join (orphan payments test)
  --     If SUM(payments) != SUM(payments joined through sale_orders), some payments
  --     have no accessible business attribution.
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,53,'Agrégats','Paiements sans attribution boutique',
    'critical', NULL,'business',NULL,
    'SUM global payments='||direct_sum.t||
    ' ≠ SUM via sale_orders='||joined_sum.t||
    ' — '||(direct_sum.t - joined_sum.t)||' en paiements non attribuables',
    1
  FROM (SELECT COALESCE(SUM(amount),0) AS t FROM payments) direct_sum,
       (SELECT COALESCE(SUM(p.amount),0) AS t
        FROM payments p JOIN sale_orders so ON so.id = p.order_id) joined_sum
  WHERE direct_sum.t != joined_sum.t;

  -- 54. COGS coverage < 90% of confirmed sale lines (per business)
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,54,'Agrégats','Taux de couverture COGS insuffisant',
    'warning', so.business_id,'business',so.business_id,
    'Boutique '||LEFT(so.business_id::TEXT,8)||': seulement '||
    ROUND(100.0*SUM(CASE WHEN sl.cost_price_at_sale IS NOT NULL THEN 1 ELSE 0 END)/COUNT(sl.id),1)||
    '% des lignes de vente ont un coût capturé — profit global surestimé',
    SUM(CASE WHEN sl.cost_price_at_sale IS NULL THEN 1 ELSE 0 END)::INT
  FROM sale_orders so
  JOIN so_lines sl ON sl.order_id = so.id
  WHERE so.status IN ('paye','credit')
    AND so.created_at > '2024-01-01'   -- adjust to date of v81 migration
  GROUP BY so.business_id
  HAVING 100.0*SUM(CASE WHEN sl.cost_price_at_sale IS NOT NULL THEN 1 ELSE 0 END)/COUNT(sl.id) < 90;

  -- 55. Business inactive for 30+ days (churn signal)
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,55,'Agrégats','Boutique inactive 30 jours',
    'warning', b.id,'business',b.id,
    'Boutique "'||b.name||'": dernière vente le '||
    COALESCE(ls.last_at::DATE::TEXT,'jamais')||
    ' ('||EXTRACT(DAY FROM now()-COALESCE(ls.last_at,b.created_at))::INT||' j)',
    1
  FROM businesses b
  LEFT JOIN (
    SELECT business_id, MAX(created_at) AS last_at
    FROM sale_orders WHERE status IN ('paye','credit')
    GROUP BY business_id
  ) ls ON ls.business_id = b.id
  WHERE (ls.last_at IS NULL OR ls.last_at < now() - INTERVAL '30 days')
    AND b.created_at < now() - INTERVAL '7 days';

  -- 56. Net profit sanity: COGS > total revenue for a business this month
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,56,'Agrégats','COGS > CA ce mois (perte brute)',
    'warning', so.business_id,'business',so.business_id,
    'Boutique '||LEFT(so.business_id::TEXT,8)||
    ': CA='||SUM(so.total_amount - so.discount_amount)||
    ' COGS='||SUM(cogs.line_cogs)||
    ' marge brute='||(SUM(so.total_amount-so.discount_amount)-SUM(cogs.line_cogs)),
    COUNT(so.id)::INT
  FROM sale_orders so
  JOIN (
    SELECT sl.order_id, SUM(sl.qty * COALESCE(sl.cost_price_at_sale,0)) AS line_cogs
    FROM so_lines sl GROUP BY sl.order_id
  ) cogs ON cogs.order_id = so.id
  WHERE so.status IN ('paye','credit')
    AND so.created_at >= DATE_TRUNC('month', CURRENT_DATE)
  GROUP BY so.business_id
  HAVING SUM(cogs.line_cogs) > SUM(so.total_amount - so.discount_amount);

  -- 57. Business with sales_orders referencing a non-existent business_id
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,57,'Agrégats','Ventes orphelines sans boutique',
    'critical', so.business_id,'sale_order',so.id,
    'Vente #'||LEFT(so.id::TEXT,8)||': business_id='||so.business_id||' introuvable',
    1
  FROM sale_orders so
  WHERE NOT EXISTS (SELECT 1 FROM businesses b WHERE b.id = so.business_id);

  -- ============================================================
  -- DOMAIN 13 — INTÉGRITÉ TEMPORELLE  (checks 58–61)
  -- ============================================================

  -- 58. Sale with created_at in the future (clock skew or bug)
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,58,'Temporel','Vente datée dans le futur',
    'critical', so.business_id,'sale_order',so.id,
    'Vente #'||LEFT(so.id::TEXT,8)||': created_at='||so.created_at||' (future)',
    1
  FROM sale_orders so
  WHERE so.created_at > now() + INTERVAL '5 minutes';

  -- 59. Payment date before associated sale date
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,59,'Temporel','Paiement antérieur à la vente',
    'critical', so.business_id,'payment',p.id,
    'Paiement #'||LEFT(p.id::TEXT,8)||
    ': created_at='||p.created_at::DATE||
    ' avant vente #'||LEFT(so.id::TEXT,8)||' ('||so.created_at::DATE||')',
    1
  FROM payments p
  JOIN sale_orders so ON so.id = p.order_id
  WHERE p.created_at < so.created_at - INTERVAL '1 minute';

  -- 60. Credit due_date is before the sale date
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,60,'Temporel','Échéance crédit antérieure à la vente',
    'warning', so.business_id,'sale_order',so.id,
    'Vente crédit #'||LEFT(so.id::TEXT,8)||
    ': due_date='||so.due_date||' avant sale_date='||so.sale_date,
    1
  FROM sale_orders so
  WHERE so.due_date IS NOT NULL
    AND so.sale_date IS NOT NULL
    AND so.due_date < so.sale_date
    AND so.status = 'credit';

  -- 61. Expense with created_at in the future
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,61,'Temporel','Dépense datée dans le futur',
    'warning', e.business_id,'expense',e.id,
    'Dépense #'||LEFT(e.id::TEXT,8)||': created_at='||e.created_at||' (future)',
    1
  FROM expenses e
  WHERE e.created_at > now() + INTERVAL '5 minutes';

  -- ============================================================
  -- DOMAIN 14 — INTÉGRITÉ RÉFÉRENTIELLE  (checks 62–68)
  -- ============================================================

  -- 62. stock_moves referencing a deleted product
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,62,'Intégrité','Mouvement de stock sans produit',
    'critical', sm.business_id,'stock_move',sm.id,
    'Mouvement #'||LEFT(sm.id::TEXT,8)||': product_id='||sm.product_id||' introuvable',
    1
  FROM stock_moves sm
  WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.id = sm.product_id);

  -- 63. stock_moves referencing a sale_order that no longer exists
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,63,'Intégrité','Mouvement de stock avec ref vente introuvable',
    'warning', sm.business_id,'stock_move',sm.id,
    'Mouvement #'||LEFT(sm.id::TEXT,8)||': ref_id='||sm.ref_id||' (vente introuvable)',
    1
  FROM stock_moves sm
  WHERE sm.ref_type IN ('vente','annulation')
    AND sm.ref_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM sale_orders so WHERE so.id = sm.ref_id);

  -- 64. so_lines referencing a deleted product_variant
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,64,'Intégrité','Ligne de vente avec variante supprimée',
    'critical', so.business_id,'so_line',sl.id,
    'Ligne #'||LEFT(sl.id::TEXT,8)||' (vente '||LEFT(so.id::TEXT,8)||
    '): variant_id='||sl.variant_id||' introuvable',
    1
  FROM so_lines sl
  JOIN sale_orders so ON so.id = sl.order_id
  WHERE sl.variant_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM product_variants pv WHERE pv.id = sl.variant_id);

  -- 65. po_lines referencing a deleted product_variant
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,65,'Intégrité','Ligne commande avec variante supprimée',
    'warning', po.business_id,'po_line',pol.id,
    'Ligne commande #'||LEFT(pol.id::TEXT,8)||
    ': variant_id='||pol.variant_id||' introuvable',
    1
  FROM po_lines pol
  JOIN purchase_orders po ON po.id = pol.po_id
  WHERE pol.variant_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM product_variants pv WHERE pv.id = pol.variant_id);

  -- 66. Business with no memberships at all
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,66,'Intégrité','Boutique sans membres',
    'critical', b.id,'business',b.id,
    'Boutique "'||b.name||'": aucun membre trouvé',
    1
  FROM businesses b
  WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.business_id = b.id);

  -- 67. Duplicate payments on same order (same amount + method + date = likely double-tap)
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,67,'Intégrité','Paiements en double sur même vente',
    'warning', so.business_id,'sale_order',so.id,
    'Vente #'||LEFT(so.id::TEXT,8)||': '||COUNT(p.id)||
    ' paiements identiques ('||p.method||' '||p.amount||') le '||p.created_at::DATE,
    COUNT(p.id)::INT
  FROM sale_orders so
  JOIN payments p ON p.order_id = so.id
  GROUP BY so.business_id, so.id, p.method, p.amount, p.created_at::DATE
  HAVING COUNT(p.id) > 1;

  -- 68. Supplier debt total exceeds total_cost of all POs for that supplier
  --     i.e. the business recorded more debt than they ever ordered (data entry error)
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,68,'Intégrité','Dettes fournisseur > total des commandes',
    'warning', sd_agg.business_id,'business',sd_agg.business_id,
    'Boutique '||LEFT(sd_agg.business_id::TEXT,8)||
    ' fournisseur '||LEFT(sd_agg.supplier_id::TEXT,8)||
    ': dettes enregistrées='||sd_agg.total_debt||
    ' total commandes='||COALESCE(po_agg.total_cost,0)||
    ' (écart='||(sd_agg.total_debt - COALESCE(po_agg.total_cost,0))||')',
    1
  FROM (
    SELECT business_id, supplier_id, SUM(amount) AS total_debt
    FROM supplier_debts GROUP BY business_id, supplier_id
  ) sd_agg
  LEFT JOIN (
    SELECT business_id, supplier_id, SUM(total_cost) AS total_cost
    FROM purchase_orders WHERE status != 'annule'
    GROUP BY business_id, supplier_id
  ) po_agg ON po_agg.business_id = sd_agg.business_id
         AND po_agg.supplier_id = sd_agg.supplier_id
  WHERE sd_agg.total_debt > COALESCE(po_agg.total_cost, 0);

  -- ============================================================
  -- Finalise the run record
  -- ============================================================
  UPDATE reconciliation_runs SET
    completed_at      = now(),
    businesses_checked = v_biz_count,
    total_findings    = (SELECT COUNT(*)   FROM reconciliation_findings WHERE run_id = v_run_id),
    critical_count    = (SELECT COUNT(*)   FROM reconciliation_findings WHERE run_id = v_run_id AND severity = 'critical'),
    warning_count     = (SELECT COUNT(*)   FROM reconciliation_findings WHERE run_id = v_run_id AND severity = 'warning'),
    status            = CASE
      WHEN (SELECT COUNT(*) FROM reconciliation_findings WHERE run_id = v_run_id AND severity = 'critical') > 0
        THEN 'findings'
      WHEN (SELECT COUNT(*) FROM reconciliation_findings WHERE run_id = v_run_id AND severity = 'warning') > 0
        THEN 'findings'
      ELSE 'clean'
    END
  WHERE id = v_run_id;

  RETURN v_run_id;

EXCEPTION WHEN OTHERS THEN
  UPDATE reconciliation_runs SET
    completed_at = now(), status = 'error', error_detail = SQLERRM
  WHERE id = v_run_id;
  RAISE;
END;
$$;

-- Only callable by service_role (the Edge Function)
GRANT EXECUTE ON FUNCTION run_reconciliation() TO service_role;

-- ─── 3. pg_cron scheduling ───────────────────────────────────
-- Run the following manually in the SQL Editor after confirming
-- the Edge Function is deployed and CRON_SECRET is set.
--
-- PREREQUISITES:
--   1. Enable pg_net extension: Extensions > pg_net in Supabase dashboard
--   2. Set CRON_SECRET in Edge Function secrets (any random string)
--   3. Replace YOUR_PROJECT_REF below with your Supabase project ref
--      (found in Settings > General > Reference ID)
--
-- SELECT cron.schedule(
--   'patron-nightly-reconciliation',
--   '0 2 * * *',   -- every night at 2:00 AM UTC
--   $$
--   SELECT net.http_post(
--     url     := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/send-reconciliation-report',
--     headers := jsonb_build_object(
--       'Content-Type',  'application/json',
--       'x-cron-secret', current_setting('app.cron_secret', true)
--     ),
--     body    := '{}'::jsonb
--   );
--   $$
-- );
--
-- To use app.cron_secret, run once:
--   ALTER DATABASE postgres SET app.cron_secret = 'your-secret-here';
-- Or just hardcode the secret string in the header above.
-- ─────────────────────────────────────────────────────────────
