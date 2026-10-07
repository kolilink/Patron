-- ============================================================
-- migration_v241 — sale_date is the merchant's LOCAL date, server-side too
--
-- BUG: submit_carnet_debt and submit_quick_sale stamped sale_orders.sale_date
-- (and, for the quick sale, payments.date) with CURRENT_DATE = the SERVER's
-- UTC date. A business west of UTC recording at 11 PM got tomorrow's date;
-- east of UTC (e.g. Pacific/Auckland) a morning sale got yesterday's. The
-- dashboard read side was already fixed (get_dashboard_kpis takes the client's
-- local p_today since v232; submit_sale takes p_sale_date), so these two
-- quick paths were the remaining writers that disagreed with it.
--
-- FIX: both RPCs gain a trailing optional `p_sale_date date DEFAULT NULL`
-- (the client's localDateISO(), captured when the entry is made — so an
-- offline-queued entry keeps the day it was really recorded). NULL = old
-- behaviour (server date), so queued payloads from older builds replay
-- unchanged. The value is clamped to +-1 day of the server date: the largest
-- real timezone skew, so a wrong device clock can't misfile a sale.
--
-- Parameter COUNT changes, so the old signatures are dropped explicitly
-- (CREATE OR REPLACE alone would leave an ambiguous second overload — see
-- migration_v132/v186). Bodies are the live ones (v186 / v215) with only
-- the date lines changed; search_path pinned to public, pg_temp (v233).
-- get_dashboard_kpis is NOT touched: it already takes p_today (v232..v240).
--
-- EXISTING ROWS are not rewritten here: the server has no per-business
-- timezone, so a blanket UPDATE would be a guess. See
-- db/maintenance/fix_sale_dates_by_timezone.sql for the explicit, reviewed
-- one-time correction.
-- ============================================================

DROP FUNCTION IF EXISTS submit_carnet_debt(uuid, uuid, text, bigint, uuid, uuid);
DROP FUNCTION IF EXISTS submit_quick_sale(uuid, uuid, bigint, numeric, text, uuid);

CREATE OR REPLACE FUNCTION submit_carnet_debt(
  p_business_id      uuid,
  p_seller_id        uuid,
  p_customer_name    text,
  p_amount           bigint,  -- already in cents (×100)
  p_client_id        uuid DEFAULT NULL,
  p_idempotency_key  uuid DEFAULT NULL,
  p_sale_date        date DEFAULT NULL   -- [v241] the client's LOCAL calendar date
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_product_id uuid;
  v_order_id   uuid;
  -- [v241] the merchant's local date, not the server's UTC date. Clamped to
  -- +-1 day of the server date (max real timezone skew) so a wrong device
  -- clock can't file a sale into another month.
  v_date       date := CASE WHEN p_sale_date IS NOT NULL AND abs(p_sale_date - CURRENT_DATE) <= 1
                            THEN p_sale_date ELSE CURRENT_DATE END;
BEGIN
  IF NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_order_id FROM sale_orders WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN RETURN v_order_id; END IF;
  END IF;

  -- Get or create the single system product for this business.
  SELECT id INTO v_product_id
  FROM products
  WHERE business_id = p_business_id AND is_system = true AND archived = false
  LIMIT 1;

  IF NOT FOUND THEN
    v_product_id := gen_random_uuid();
    INSERT INTO products (
      id, business_id, name, unit,
      cost_price, sale_price, stock_qty, reorder_level,
      archived, is_system, created_by, created_at, updated_at
    ) VALUES (
      v_product_id, p_business_id, 'Solde reporté', 'unité',
      0, 0, 999999, 0,
      false, true, p_seller_id, NOW(), NOW()
    );
  END IF;

  v_order_id := gen_random_uuid();

  BEGIN
    INSERT INTO sale_orders (
      id, business_id, seller_id, customer_name, client_id,
      status, is_credit, total_amount, discount_amount,
      sale_date, idempotency_key, created_at, updated_at, created_by
    ) VALUES (
      v_order_id, p_business_id, p_seller_id, p_customer_name, p_client_id,
      'credit', true, p_amount, 0,
      v_date, coalesce(p_idempotency_key, gen_random_uuid()), NOW(), NOW(), p_seller_id
    );
  EXCEPTION WHEN unique_violation THEN
    -- Race: another concurrent call with the same key committed first
    -- (offline-queue retry racing a live retry, or two devices post-
    -- reconnect) — return its order instead of raising a raw duplicate-key
    -- error, same recovery submit_sale already has.
    IF p_idempotency_key IS NOT NULL THEN
      SELECT id INTO v_order_id FROM sale_orders WHERE idempotency_key = p_idempotency_key;
      IF FOUND THEN RETURN v_order_id; END IF;
    END IF;
    RAISE;
  END;

  INSERT INTO so_lines (
    id, order_id, product_id, product_name,
    qty, unit_price, is_bulk
  ) VALUES (
    gen_random_uuid(), v_order_id, v_product_id, 'Solde reporté',
    1, p_amount, false
  );

  RETURN v_order_id;
END;
$$;

GRANT EXECUTE ON FUNCTION submit_carnet_debt(uuid, uuid, text, bigint, uuid, uuid, date) TO authenticated;
REVOKE EXECUTE ON FUNCTION submit_carnet_debt(uuid, uuid, text, bigint, uuid, uuid, date) FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION submit_quick_sale(
  p_business_id      uuid,
  p_seller_id        uuid,
  p_unit_price       bigint,           -- cents (×100)
  p_qty              numeric DEFAULT 1,
  p_label            text    DEFAULT NULL,  -- free text, e.g. "Riz, sac de 5kg" — optional
  p_idempotency_key  uuid    DEFAULT NULL,
  p_sale_date        date    DEFAULT NULL   -- [v241] the client's LOCAL calendar date
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_product_id uuid;
  v_order_id   uuid;
  v_total      bigint;
  v_label      text;
  -- [v241] see submit_carnet_debt: local date, clamped to +-1 day of server date.
  v_date       date := CASE WHEN p_sale_date IS NOT NULL AND abs(p_sale_date - CURRENT_DATE) <= 1
                            THEN p_sale_date ELSE CURRENT_DATE END;
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
      v_date, coalesce(p_idempotency_key, gen_random_uuid()), NOW(), NOW(), p_seller_id
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
    gen_random_uuid(), v_order_id, p_business_id, 'especes', v_total, v_date,
    auth.uid()
  );

  RETURN v_order_id;
END;
$$;

GRANT EXECUTE ON FUNCTION submit_quick_sale(uuid, uuid, bigint, numeric, text, uuid, date) TO authenticated;
REVOKE EXECUTE ON FUNCTION submit_quick_sale(uuid, uuid, bigint, numeric, text, uuid, date) FROM PUBLIC, anon;
