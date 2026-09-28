-- ============================================================
-- Patron — Migration v198
-- Run in Supabase SQL Editor AFTER migration_v197
--
-- Quick sale redesign — "Vente rapide" in the rapid capture sheet, replacing
-- the old "Nouvelle vente" name-typing form (app/(app)/onboarding/vente-
-- rapide.tsx, deleted). The hard product rule this backs: "Pas de produit,
-- pas de quantité [inventé]" — a quick sale must never invent a real catalog
-- product or move real inventory, the way the old form's createProduct() +
-- submit_sale() path always did (it cloned whatever was typed into a real,
-- visible product with real starting stock). It DOES take a real quantity
-- and an optional free-text label typed by the merchant — those are hers to
-- give, just never persisted as a catalog product or a stock movement.
--
-- REVISED before ever being applied to any database (confirmed via a direct
-- production query — this function never existed there) after the first
-- version shipped amount-only with no qty/label fields, then the product
-- spec added them back in the same week: "Qu'avez-vous vendu ? (optionnel)"
-- + a quantity stepper (default 1) + "Prix unitaire", with the total (qty ×
-- unit price) computed server-side and shown on the button itself
-- ("Ajouter · {total}"). Same posture already established elsewhere in this
-- file's own history (migration_v164.sql, migration_v169.sql) — a migration
-- that was never live gets corrected in place, not superseded by a new
-- version number, so the numbered history only ever reflects what was
-- actually true in production at some point.
--
-- submit_sale() cannot be reused as-is for this: migration_v195's fuzz-pass
-- validation requires every cart line's product_id to reference a real,
-- existing products row owned by the business. That's correct for submit_sale
-- (a real cart of real items) and is exactly why submit_carnet_debt()
-- (migration_v59-62, hardened in v178) already had to invent its own
-- workaround for the same shape of problem on the credit side: a single
-- hidden `is_system` placeholder product ("Solde reporté") that every credit
-- debt's one so_lines row points at, so the FK constraint on so_lines.
-- product_id (not null references products(id)) is satisfied without ever
-- creating a real, visible catalog product.
--
-- submit_quick_sale() below is the same pattern, mirrored for a PAID cash
-- sale instead of a credit debt — a new, separate is_system placeholder
-- ("Vente rapide", not "Solde reporté") rather than sharing the debt's one,
-- so a human spot-checking raw data (or a future report) can tell "this was
-- a quick cash sale" apart from "this was a carried-over credit balance" at
-- a glance instead of both aggregating under one meaningless placeholder
-- name. The PLACEHOLDER PRODUCT's own name always stays "Vente rapide" (one
-- shared, hidden, get-or-create row per business) — what the merchant typed
-- (if anything) is stored separately, on so_lines.product_name, exactly the
-- per-line denormalized snapshot column migration_v54 added for this reason
-- (a line's own label can differ from its product's live name). Like
-- submit_carnet_debt, it writes zero stock_moves rows and never touches any
-- real product's stock_qty — the placeholder's own stock_qty is a fixed
-- 999999 that's never read as a real balance anywhere (already excluded
-- from every stock-consistency reconciliation check via is_system, same as
-- "Solde reporté" already is — migration_v104).
--
-- Also fixed in the same migration: get_best_sellers() (migration_v70) has
-- never filtered is_system, so submit_carnet_debt's "Solde reporté" line has
-- been silently polluting "meilleurs produits" rankings with credit-debt
-- totals since that feature shipped — a real, pre-existing gap, not
-- introduced by this migration, but one this migration would otherwise
-- double by adding a second is_system placeholder into the same unfiltered
-- ranking. One-line fix, no signature change.
-- ============================================================

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
  -- see the migration header for why this can't just be submit_carnet_debt's
  -- own "Solde reporté" product, and why what the merchant typed lives on
  -- so_lines.product_name instead of here.
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

  -- Never trust a client-supplied total — derive it from qty × unit price,
  -- same "bundle the money with the mutation, compute don't trust" posture
  -- submit_sale/edit_sale already use for their own totals.
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
    -- Race: another concurrent call with the same key committed first
    -- (offline-queue retry racing a live retry, or two devices post-
    -- reconnect) — return its order instead of raising a raw duplicate-key
    -- error, same recovery submit_sale/submit_carnet_debt already have.
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

  INSERT INTO payments (id, order_id, business_id, method, amount, date)
  VALUES (
    gen_random_uuid(), v_order_id, p_business_id, 'especes', v_total, CURRENT_DATE
  );

  RETURN v_order_id;
END;
$$;

GRANT EXECUTE ON FUNCTION submit_quick_sale(uuid, uuid, bigint, numeric, text, uuid) TO authenticated;

-- ─── get_best_sellers: exclude is_system placeholders ────────────────────
-- No signature change (same 3 params) — CREATE OR REPLACE is safe.

CREATE OR REPLACE FUNCTION public.get_best_sellers(
  p_business_id uuid,
  p_month_start date,
  p_limit       int DEFAULT 5
)
RETURNS TABLE(
  product_id    uuid,
  product_name  text,
  total_qty     numeric,
  total_revenue numeric
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT
    sl.product_id,
    p.name           AS product_name,
    SUM(sl.qty)                  AS total_qty,
    SUM(sl.qty * sl.unit_price)  AS total_revenue
  FROM so_lines sl
  JOIN products p     ON p.id  = sl.product_id
  JOIN sale_orders so ON so.id = sl.order_id
  WHERE so.business_id = p_business_id
    AND so.status IN ('paye', 'credit')
    AND so.sale_date >= p_month_start
    AND p.archived = false
    AND p.is_system = false
  GROUP BY sl.product_id, p.name
  ORDER BY total_revenue DESC
  LIMIT p_limit;
$$;
