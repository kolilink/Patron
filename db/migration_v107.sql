-- ============================================================
-- Patron — Migration v107
-- Run in Supabase SQL Editor AFTER migration_v106
--
-- Collapses so_lines.unit_price / unit_price_paid into a single
-- field. Selling above catalog price stays fully allowed — this
-- only changes how that price is stored.
--
-- Background: when a merchant sells above catalog price,
-- so_lines.unit_price was left at the catalog price and the real
-- price was stashed in a second, nullable column
-- (unit_price_paid, added v93). Every consumer of "how much did
-- this line actually sell for" had to remember to read
-- COALESCE(unit_price_paid, unit_price) instead of unit_price
-- alone. Auditing every call site found three that needed it —
-- get_product_stats and run_reconciliation check #9 did it
-- correctly; get_best_sellers (v70) did NOT, and has been quietly
-- understating revenue for above-catalog sales in the "meilleures
-- ventes" stat ever since. That's exactly the class of bug this
-- migration removes, rather than fixing one more call site.
--
-- After this migration, so_lines.unit_price always holds the real
-- price charged for that line — no second field, no COALESCE
-- required anywhere, nothing to forget at the next call site.
--
-- 1. Backfill: fold the already-correct unit_price_paid value
--    into unit_price for every historical line that has one.
-- 2. submit_sale — stops reading/writing unit_price_paid; the
--    client now sends the real per-unit price directly as
--    unit_price (see stores/sales.ts in this same change set).
-- 3. get_product_stats — drops the now-unnecessary COALESCE.
-- 4. run_reconciliation — check #9 drops the COALESCE too.
-- 5. Drops the now-unused unit_price_paid column.
--
-- get_best_sellers (v70) needs no code change — it already reads
-- plain unit_price, which is now simply correct.
-- ============================================================

-- ─── 1. Backfill ─────────────────────────────────────────────
UPDATE so_lines
SET unit_price = unit_price_paid
WHERE unit_price_paid IS NOT NULL;

-- ─── 2. submit_sale — single source of truth for price charged ─
-- Identical to v96 except: so_lines no longer stores
-- unit_price_paid, and the investor profit calc reads unit_price
-- directly instead of COALESCE(unit_price_paid, unit_price).

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
BEGIN
  IF get_role(p_business_id) NOT IN ('administrateur', 'manager', 'vendeur') THEN
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

  v_order_id := gen_random_uuid();

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
    p_total_amount, p_discount_amount,
    auth.uid(), p_idempotency_key
  );

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_cart) LOOP
    -- Cost snapshot: variant first, fall back to parent product
    v_cost_price := NULL;
    IF nullif(v_item->>'variant_id', '') IS NOT NULL THEN
      SELECT cost_price INTO v_cost_price
      FROM product_variants
      WHERE id = nullif(v_item->>'variant_id', '')::uuid;
    END IF;
    IF v_cost_price IS NULL THEN
      SELECT cost_price INTO v_cost_price
      FROM products
      WHERE id = (v_item->>'product_id')::uuid;
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
    INSERT INTO payments (id, order_id, customer_name, business_id, method, amount, date, ref_external)
    VALUES (
      gen_random_uuid(), v_order_id,
      nullif(trim(coalesce(p_customer_name, '')), ''),
      p_business_id, p_pay_method, p_pay_amount, p_sale_date,
      nullif(trim(coalesce(p_pay_ref, '')), '')
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
      UPDATE products
      SET stock_qty = GREATEST(0, stock_qty - (v_item->>'qty')::numeric)
      WHERE id = (v_item->>'product_id')::uuid;

      UPDATE product_variants
      SET stock_qty = stock_qty - (v_item->>'qty')::numeric
      WHERE id     = nullif(v_item->>'variant_id', '')::uuid
        AND stock_qty >= (v_item->>'qty')::numeric;

      GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
      IF v_rows_affected = 0 THEN
        RAISE EXCEPTION 'Stock insuffisant : %',
          coalesce(nullif(v_item->>'variant_name', ''), v_item->>'product_name', 'Produit inconnu')
          USING ERRCODE = 'P0001';
      END IF;
    ELSE
      -- Plain product: guard is on products.
      UPDATE products
      SET stock_qty = stock_qty - (v_item->>'qty')::numeric
      WHERE id      = (v_item->>'product_id')::uuid
        AND stock_qty >= (v_item->>'qty')::numeric;

      GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
      IF v_rows_affected = 0 THEN
        RAISE EXCEPTION 'Stock insuffisant : %',
          coalesce(v_item->>'product_name', 'Produit inconnu')
          USING ERRCODE = 'P0001';
      END IF;
    END IF;

    -- Investor profit accumulation: unit_price is now always the real price charged.
    v_cost_price := NULL;
    IF nullif(v_item->>'variant_id', '') IS NOT NULL THEN
      SELECT cost_price INTO v_cost_price
      FROM product_variants
      WHERE id = nullif(v_item->>'variant_id', '')::uuid;
    END IF;
    IF v_cost_price IS NULL THEN
      SELECT cost_price INTO v_cost_price
      FROM products
      WHERE id = (v_item->>'product_id')::uuid;
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

GRANT EXECUTE ON FUNCTION public.submit_sale(uuid,uuid,text,date,numeric,numeric,boolean,jsonb,text,numeric,text,uuid,uuid,date) TO authenticated;

-- ─── 3. get_product_stats — drop the now-unnecessary COALESCE ──

CREATE OR REPLACE FUNCTION get_product_stats(
  p_product_id  uuid,
  p_business_id uuid,
  p_since       timestamptz DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cost_price      bigint;
  v_revenue         bigint;
  v_capital         bigint;
  v_qty_lost        bigint;
  v_linked_expenses bigint;
BEGIN
  IF NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé';
  END IF;

  SELECT cost_price INTO v_cost_price
  FROM products
  WHERE id = p_product_id AND business_id = p_business_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Produit introuvable';
  END IF;

  -- Revenue: unit_price is always the real price charged (v107).
  SELECT COALESCE(SUM(sl.unit_price * sl.qty), 0)
  INTO v_revenue
  FROM so_lines sl
  JOIN sale_orders so ON so.id = sl.order_id
  WHERE sl.product_id = p_product_id
    AND so.business_id = p_business_id
    AND so.status != 'annule'
    AND (p_since IS NULL OR so.created_at >= p_since);

  -- Capital (COGS): snapshotted cost, fall back to variant then product cost
  SELECT COALESCE(SUM(
    sl.qty * COALESCE(sl.cost_price_at_sale, pv.cost_price, v_cost_price)
  ), 0)
  INTO v_capital
  FROM so_lines sl
  JOIN sale_orders so ON so.id = sl.order_id
  LEFT JOIN product_variants pv ON pv.id = sl.variant_id
  WHERE sl.product_id = p_product_id
    AND so.business_id = p_business_id
    AND so.status != 'annule'
    AND (p_since IS NULL OR so.created_at >= p_since);

  -- Losses
  SELECT COALESCE(SUM(qty), 0)
  INTO v_qty_lost
  FROM stock_moves
  WHERE product_id = p_product_id
    AND business_id = p_business_id
    AND type = 'perte'
    AND (p_since IS NULL OR created_at >= p_since);

  v_capital := v_capital + v_qty_lost * v_cost_price;

  -- Linked approved expenses
  SELECT COALESCE(SUM(amount), 0)
  INTO v_linked_expenses
  FROM expenses
  WHERE product_id   = p_product_id
    AND business_id  = p_business_id
    AND status       = 'approuve'
    AND (p_since IS NULL OR date >= p_since::date);

  RETURN json_build_object(
    'revenue',          v_revenue,
    'capital',          v_capital,
    'linked_expenses',  v_linked_expenses,
    'profit',           v_revenue - v_capital - v_linked_expenses
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_product_stats(uuid, uuid, timestamptz) TO authenticated;

-- ─── 4. run_reconciliation — check #9 drops the COALESCE ────────
-- Identical to v105 except check #9's inner SELECT sums plain
-- unit_price instead of COALESCE(unit_price_paid, unit_price).

CREATE OR REPLACE FUNCTION run_reconciliation()
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run_id UUID;
  v_biz_count INTEGER;
BEGIN
  INSERT INTO reconciliation_runs DEFAULT VALUES RETURNING id INTO v_run_id;
  SELECT COUNT(*) INTO v_biz_count FROM businesses;

  -- ============================================================
  -- DOMAIN 1 — STOCK  (checks 1–8)
  -- ============================================================

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,1,'Stock','Sortie stock manquante pour vente confirmée',
    'critical', so.business_id,'sale_order',so.id,
    'Vente #'||LEFT(so.id::TEXT,8)||' ('||so.status||'): '||COUNT(sl.id)||
    ' ligne(s) sans mouvement de stock "sortie" correspondant',
    COUNT(sl.id)::INT
  FROM sale_orders so
  JOIN so_lines sl ON sl.order_id = so.id
  JOIN products p ON p.id = sl.product_id
  WHERE so.status IN ('paye','credit')
    AND p.is_system = false
    AND NOT EXISTS (
      SELECT 1 FROM stock_moves sm
      WHERE sm.ref_id = so.id AND sm.type = 'sortie' AND sm.product_id = sl.product_id
    )
  GROUP BY so.business_id, so.id, so.status
  HAVING COUNT(sl.id) > 0;

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,2,'Stock','Quantité sortie ≠ quantité vendue',
    'critical', so.business_id,'sale_order',so.id,
    'Vente #'||LEFT(so.id::TEXT,8)||' produit "'||sl_agg.product_name||
    '": so_lines.qty(total)='||sl_agg.total||' mais stock_moves.qty='||COALESCE(sm_agg.total,0),
    1
  FROM sale_orders so
  JOIN (
    SELECT sl.order_id, sl.product_id,
      SUM(sl.qty) AS total,
      MAX(COALESCE(sl.product_name, sl.product_id::TEXT)) AS product_name
    FROM so_lines sl
    JOIN products p ON p.id = sl.product_id
    WHERE p.is_system = false
    GROUP BY sl.order_id, sl.product_id
  ) sl_agg ON sl_agg.order_id = so.id
  LEFT JOIN (
    SELECT ref_id, product_id, SUM(qty) AS total
    FROM stock_moves WHERE type = 'sortie'
    GROUP BY ref_id, product_id
  ) sm_agg ON sm_agg.ref_id = so.id AND sm_agg.product_id = sl_agg.product_id
  WHERE so.status IN ('paye','credit')
    AND sl_agg.total != COALESCE(sm_agg.total, 0);

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
    AND sl.cost_price_at_sale IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM stock_moves sm
      WHERE sm.ref_id = so.id
        AND sm.type = 'entree'
        AND sm.product_id = sl.product_id
    )
  GROUP BY so.business_id, so.id
  HAVING COUNT(sl.id) > 0;

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

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,5,'Stock','Stock produit négatif',
    'critical', p.business_id,'product',p.id,
    'Produit "'||p.name||'": stock_qty='||p.stock_qty||' (négatif — vente sans stock disponible)',
    1
  FROM products p WHERE p.stock_qty < 0;

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,6,'Stock','Stock variante négatif',
    'critical', p.business_id,'product_variant',pv.id,
    'Variante "'||pv.name||'" (produit "'||p.name||'"): stock_qty='||pv.stock_qty||' (négatif)',
    1
  FROM product_variants pv
  JOIN products p ON p.id = pv.product_id
  WHERE pv.stock_qty < 0;

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
  --    [v107] unit_price is now always the real price charged —
  --    no COALESCE(unit_price_paid, unit_price) needed any more.
  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,9,'Ventes','Total vente ≠ somme des lignes',
    'critical', so.business_id,'sale_order',so.id,
    'Vente #'||LEFT(so.id::TEXT,8)||': total_amount='||so.total_amount||
    ' mais ∑(qty×prix payé)='||COALESCE(ls.total,0)||
    ' (écart='||(so.total_amount - COALESCE(ls.total,0))||')',
    1
  FROM sale_orders so
  LEFT JOIN (
    SELECT order_id, SUM(qty * unit_price) AS total
    FROM so_lines GROUP BY order_id
  ) ls ON ls.order_id = so.id
  WHERE so.status IN ('paye','credit','annule')
    AND so.total_amount != COALESCE(ls.total, 0);

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

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,12,'Ventes','Lignes de vente orphelines',
    'critical', NULL,'so_line',sl.id,
    'so_line #'||LEFT(sl.id::TEXT,8)||': order_id='||sl.order_id||' introuvable',
    1
  FROM so_lines sl
  WHERE NOT EXISTS (SELECT 1 FROM sale_orders so WHERE so.id = sl.order_id);

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
  -- DOMAIN 3 — PAYMENTS  (checks 16–22, 69)
  -- ============================================================

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

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,21,'Paiements','Paiement sans vente associée',
    'critical', NULL,'payment',p.id,
    'Paiement #'||LEFT(p.id::TEXT,8)||': order_id='||p.order_id||' introuvable',
    1
  FROM payments p
  WHERE NOT EXISTS (SELECT 1 FROM sale_orders so WHERE so.id = p.order_id);

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

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,69,'Paiements','Vente "paye" surpayée',
    'critical', so.business_id,'sale_order',so.id,
    'Vente #'||LEFT(so.id::TEXT,8)||': net dû='||
    (so.total_amount - so.discount_amount)||
    ' paiements reçus='||ps.total||
    ' (surplus='||(ps.total - (so.total_amount - so.discount_amount))||')',
    1
  FROM sale_orders so
  JOIN (
    SELECT order_id, SUM(amount) AS total FROM payments GROUP BY order_id
  ) ps ON ps.order_id = so.id
  WHERE so.status = 'paye'
    AND ps.total > (so.total_amount - so.discount_amount);

  -- ============================================================
  -- DOMAIN 4 — COGS ET COÛT DE REVIENT  (checks 23–26)
  -- ============================================================

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

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,27,'Dépenses','Montant de dépense nul ou négatif',
    'critical', e.business_id,'expense',e.id,
    'Dépense #'||LEFT(e.id::TEXT,8)||': amount='||e.amount||' (invalide)',
    1
  FROM expenses e WHERE e.amount <= 0;

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,28,'Dépenses','Statut dépense invalide',
    'critical', e.business_id,'expense',e.id,
    'Dépense #'||LEFT(e.id::TEXT,8)||': statut="'||e.status||'" non reconnu',
    1
  FROM expenses e
  WHERE e.status NOT IN ('en_attente','approuve','rejete');

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,29,'Dépenses','Dépense sans boutique',
    'critical', e.business_id,'expense',e.id,
    'Dépense #'||LEFT(e.id::TEXT,8)||': business_id='||e.business_id||' introuvable',
    1
  FROM expenses e
  WHERE NOT EXISTS (SELECT 1 FROM businesses b WHERE b.id = e.business_id);

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

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,33,'Crédit','Vente avec client inexistant',
    'warning', so.business_id,'sale_order',so.id,
    'Vente #'||LEFT(so.id::TEXT,8)||': client_id='||so.client_id||' introuvable',
    1
  FROM sale_orders so
  WHERE so.client_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM clients c WHERE c.id = so.client_id);

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

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,35,'Fournisseurs','Surpaiement fournisseur',
    'warning', sd.business_id,'supplier_debt',sd.id,
    'Dette fournisseur #'||LEFT(sd.id::TEXT,8)||
    ': montant='||sd.amount||' amount_paid='||sd.amount_paid||
    ' (surplus='||(sd.amount_paid - sd.amount)||')',
    1
  FROM supplier_debts sd WHERE sd.amount_paid > sd.amount;

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

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,39,'Commandes','Ligne de commande avec produit inexistant',
    'critical', po.business_id,'purchase_order',po.id,
    'Commande #'||LEFT(po.id::TEXT,8)||': product_id='||pol.product_id||' introuvable',
    1
  FROM po_lines pol
  JOIN purchase_orders po ON po.id = pol.po_id
  WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.id = pol.product_id);

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

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,41,'Produits','Prix de vente nul ou négatif',
    'critical', p.business_id,'product',p.id,
    'Produit actif "'||p.name||'": sale_price='||p.sale_price||
    ' — toute vente enregistre un CA de 0',
    1
  FROM products p
  WHERE p.sale_price <= 0 AND p.archived = false AND p.is_system = false;

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

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,47,'Montants','Montant vente anormalement élevé',
    'warning', so.business_id,'sale_order',so.id,
    'Vente #'||LEFT(so.id::TEXT,8)||': total_amount='||so.total_amount||
    ' ('||(so.total_amount/100)||' unités) — possible erreur de saisie',
    1
  FROM sale_orders so
  WHERE so.total_amount > 1000000000000
    AND so.status IN ('paye','credit');

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

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,50,'Membres','Plus d''un manager',
    'critical', m.business_id,'business',m.business_id,
    'Boutique '||LEFT(m.business_id::TEXT,8)||': '||COUNT(m.id)||' managers (max 1)',
    COUNT(m.id)::INT
  FROM memberships m
  WHERE m.role = 'manager'
  GROUP BY m.business_id HAVING COUNT(m.id) > 1;

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,51,'Membres','Rôle invalide',
    'critical', m.business_id,'membership',m.id,
    'Membership #'||LEFT(m.id::TEXT,8)||': rôle="'||m.role||'" non reconnu',
    1
  FROM memberships m
  WHERE m.role NOT IN ('administrateur','manager','vendeur','investisseur');

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
    AND so.created_at > '2024-01-01'
  GROUP BY so.business_id
  HAVING 100.0*SUM(CASE WHEN sl.cost_price_at_sale IS NOT NULL THEN 1 ELSE 0 END)/COUNT(sl.id) < 90;

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

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,58,'Temporel','Vente datée dans le futur',
    'critical', so.business_id,'sale_order',so.id,
    'Vente #'||LEFT(so.id::TEXT,8)||': created_at='||so.created_at||' (future)',
    1
  FROM sale_orders so
  WHERE so.created_at > now() + INTERVAL '5 minutes';

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

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,62,'Intégrité','Mouvement de stock sans produit',
    'critical', sm.business_id,'stock_move',sm.id,
    'Mouvement #'||LEFT(sm.id::TEXT,8)||': product_id='||sm.product_id||' introuvable',
    1
  FROM stock_moves sm
  WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.id = sm.product_id);

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

  INSERT INTO reconciliation_findings
    (run_id,check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count)
  SELECT v_run_id,66,'Intégrité','Boutique sans membres',
    'critical', b.id,'business',b.id,
    'Boutique "'||b.name||'": aucun membre trouvé',
    1
  FROM businesses b
  WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.business_id = b.id);

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

GRANT EXECUTE ON FUNCTION run_reconciliation() TO service_role;

-- ─── 5. Drop the now-unused column ───────────────────────────
ALTER TABLE so_lines DROP COLUMN IF EXISTS unit_price_paid;
