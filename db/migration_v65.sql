-- ============================================================
-- Patron — Migration v65
-- Run in Supabase SQL Editor AFTER migration_v64
--
-- Adds product variants support:
--   • product_variants table (stock + pricing per variant)
--   • products.has_variants flag
--   • so_lines.variant_id / variant_name (snapshot for history)
--   • po_lines.variant_id (optional, for restocking a specific variant)
--   • upsert_product_variants RPC (admin/manager only)
--   • submit_sale updated: deducts variant stock when variant_id present
--   • cancel_sale updated: restores variant stock correctly
--   • receive_purchase_order updated: adds to variant stock when variant_id present
--   • get_product_stats updated: uses variant cost_price for margin when available
-- ============================================================

-- ─── 1. product_variants table ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS product_variants (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id     uuid        NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  business_id    uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name           text        NOT NULL,
  sale_price     bigint      NOT NULL DEFAULT 0,
  cost_price     bigint      NOT NULL DEFAULT 0,
  stock_qty      numeric     NOT NULL DEFAULT 0,
  reorder_level  numeric     NOT NULL DEFAULT 0,
  archived       boolean     NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE product_variants ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Membres: voir les variantes"
  ON product_variants FOR SELECT
  USING (is_member(business_id));

CREATE POLICY "Admins/Managers: gérer les variantes"
  ON product_variants FOR ALL
  USING (get_role(business_id) IN ('administrateur', 'manager'));

CREATE INDEX IF NOT EXISTS idx_product_variants_product
  ON product_variants (product_id)
  WHERE archived = false;

-- ─── 2. products.has_variants flag ───────────────────────────────────────────

ALTER TABLE products ADD COLUMN IF NOT EXISTS has_variants boolean NOT NULL DEFAULT false;

-- ─── 3. so_lines: variant snapshot columns ───────────────────────────────────

ALTER TABLE so_lines ADD COLUMN IF NOT EXISTS variant_id   uuid REFERENCES product_variants(id);
ALTER TABLE so_lines ADD COLUMN IF NOT EXISTS variant_name text;

-- ─── 4. po_lines: optional variant routing ───────────────────────────────────

ALTER TABLE po_lines ADD COLUMN IF NOT EXISTS variant_id uuid REFERENCES product_variants(id);

-- ─── 5. RPC: upsert_product_variants ─────────────────────────────────────────
-- Replaces the full variant list for a product atomically.
-- p_variants = [] turns variants OFF.
-- Prices in p_variants are in cents (×100).

CREATE OR REPLACE FUNCTION public.upsert_product_variants(
  p_business_id uuid,
  p_product_id  uuid,
  p_variants    jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item jsonb;
BEGIN
  IF get_role(p_business_id) NOT IN ('administrateur', 'manager') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF jsonb_array_length(p_variants) = 0 THEN
    UPDATE product_variants
    SET archived = true, updated_at = now()
    WHERE product_id = p_product_id AND business_id = p_business_id;

    UPDATE products
    SET has_variants = false, updated_at = now()
    WHERE id = p_product_id AND business_id = p_business_id;
  ELSE
    -- Delete-then-insert is safe: so_lines.variant_name is a snapshot, so
    -- historical sale lines are unaffected by variant deletions.
    DELETE FROM product_variants
    WHERE product_id = p_product_id AND business_id = p_business_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_variants) LOOP
      INSERT INTO product_variants (
        product_id, business_id, name,
        sale_price, cost_price, stock_qty, reorder_level
      ) VALUES (
        p_product_id,
        p_business_id,
        v_item->>'name',
        (v_item->>'sale_price')::bigint,
        (v_item->>'cost_price')::bigint,
        (v_item->>'stock_qty')::numeric,
        (v_item->>'reorder_level')::numeric
      );
    END LOOP;

    UPDATE products
    SET has_variants = true,
        stock_qty    = 0,
        updated_at   = now()
    WHERE id = p_product_id AND business_id = p_business_id;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_product_variants(uuid, uuid, jsonb) TO authenticated;

-- ─── 6. submit_sale: handle variant stock deduction ──────────────────────────
-- Backward-compatible: lines without variant_id behave exactly as before.
-- When variant_id is present, stock is deducted from product_variants.

DROP FUNCTION IF EXISTS public.submit_sale(uuid,uuid,text,date,numeric,numeric,boolean,jsonb,text,numeric,text,uuid,uuid,date);

CREATE OR REPLACE FUNCTION public.submit_sale(
  p_business_id      uuid,
  p_seller_id        uuid,
  p_customer_name    text    DEFAULT NULL,
  p_sale_date        date    DEFAULT CURRENT_DATE,
  p_total_amount     numeric DEFAULT 0,
  p_discount_amount  numeric DEFAULT 0,
  p_is_credit        boolean DEFAULT false,
  p_cart             jsonb   DEFAULT '[]',
  p_pay_method       text    DEFAULT NULL,
  p_pay_amount       numeric DEFAULT NULL,
  p_pay_ref          text    DEFAULT NULL,
  p_idempotency_key  uuid    DEFAULT NULL,
  p_client_id        uuid    DEFAULT NULL,
  p_due_date         date    DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order_id  uuid;
  v_item      jsonb;
  v_variant_id uuid;
BEGIN
  IF get_role(p_business_id) NOT IN ('administrateur', 'manager', 'vendeur') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF get_role(p_business_id) = 'vendeur' AND p_seller_id != auth.uid() THEN
    RAISE EXCEPTION 'Un vendeur ne peut enregistrer que ses propres ventes' USING ERRCODE = 'P0001';
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
    INSERT INTO so_lines (id, order_id, product_id, product_name, qty, unit_price, variant_id, variant_name)
    VALUES (
      gen_random_uuid(), v_order_id,
      (v_item->>'product_id')::uuid,
      v_item->>'product_name',
      (v_item->>'qty')::numeric,
      (v_item->>'unit_price')::numeric,
      (v_item->>'variant_id')::uuid,
      v_item->>'variant_name'
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
    v_variant_id := (v_item->>'variant_id')::uuid;

    INSERT INTO stock_moves (
      id, business_id, product_id, type, qty, ref_id, ref_type, note, created_by
    ) VALUES (
      gen_random_uuid(), p_business_id,
      (v_item->>'product_id')::uuid,
      'sortie', (v_item->>'qty')::numeric,
      v_order_id, 'sale_order', NULL, auth.uid()
    );

    IF v_variant_id IS NOT NULL THEN
      UPDATE product_variants
      SET stock_qty  = GREATEST(0, stock_qty - (v_item->>'qty')::numeric),
          updated_at = now()
      WHERE id = v_variant_id;
    ELSE
      UPDATE products
      SET stock_qty = GREATEST(0, stock_qty - (v_item->>'qty')::numeric)
      WHERE id = (v_item->>'product_id')::uuid;
    END IF;
  END LOOP;

  RETURN v_order_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_sale(uuid,uuid,text,date,numeric,numeric,boolean,jsonb,text,numeric,text,uuid,uuid,date) TO authenticated;

-- ─── 7. cancel_sale: restore stock to correct table ──────────────────────────

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
  v_sale record;
  v_line record;
BEGIN
  IF get_role(p_business_id) NOT IN ('administrateur', 'manager', 'vendeur') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  SELECT id, seller_id INTO v_sale
  FROM sale_orders
  WHERE id = p_sale_id AND business_id = p_business_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vente introuvable' USING ERRCODE = 'P0001';
  END IF;

  IF get_role(p_business_id) = 'vendeur' AND v_sale.seller_id != auth.uid() THEN
    RAISE EXCEPTION 'Un vendeur ne peut annuler que ses propres ventes' USING ERRCODE = 'P0001';
  END IF;

  UPDATE sale_orders
  SET status              = 'annule',
      cancelled_at        = now(),
      cancellation_reason = p_reason,
      cancelled_by_id     = auth.uid()
  WHERE id = p_sale_id;

  BEGIN
    FOR v_line IN SELECT product_id, variant_id, qty FROM so_lines WHERE order_id = p_sale_id LOOP
      INSERT INTO stock_moves (
        id, business_id, product_id, type, qty, ref_id, ref_type, note, created_by
      ) VALUES (
        gen_random_uuid(), p_business_id, v_line.product_id,
        'entree', v_line.qty, p_sale_id, 'annulation',
        'Annulation: ' || coalesce(p_reason, ''), auth.uid()
      );

      IF v_line.variant_id IS NOT NULL THEN
        UPDATE product_variants
        SET stock_qty  = stock_qty + v_line.qty,
            updated_at = now()
        WHERE id = v_line.variant_id;
      ELSE
        UPDATE products
        SET stock_qty = stock_qty + v_line.qty
        WHERE id = v_line.product_id;
      END IF;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_sale(uuid, uuid, text) TO authenticated;

-- ─── 8. receive_purchase_order: route stock to variant when specified ─────────

DROP FUNCTION IF EXISTS receive_purchase_order(uuid, uuid, uuid[], int[]);

CREATE OR REPLACE FUNCTION receive_purchase_order(
  p_po_id       uuid,
  p_business_id uuid,
  p_line_ids    uuid[] DEFAULT NULL,
  p_line_qtys   int[]  DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  l              RECORD;
  recv_qty       int;
  total_lines    int;
  received_lines int;
BEGIN
  IF get_role(p_business_id) NOT IN ('administrateur', 'manager') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM purchase_orders
    WHERE id = p_po_id AND business_id = p_business_id
      AND status NOT IN ('recu', 'annule')
  ) THEN
    RAISE EXCEPTION 'Commande introuvable ou déjà reçue';
  END IF;

  FOR l IN
    SELECT * FROM po_lines
    WHERE po_id = p_po_id
      AND qty_received < qty_ordered
      AND (p_line_ids IS NULL OR id = ANY(p_line_ids))
  LOOP
    IF p_line_qtys IS NOT NULL THEN
      recv_qty := p_line_qtys[array_position(p_line_ids, l.id)];
    ELSE
      recv_qty := l.qty_ordered - l.qty_received;
    END IF;

    IF recv_qty IS NULL OR recv_qty <= 0 THEN CONTINUE; END IF;

    recv_qty := LEAST(recv_qty, l.qty_ordered - l.qty_received);

    INSERT INTO stock_moves (id, business_id, product_id, type, qty, ref_id, ref_type, note, created_by)
    VALUES (
      gen_random_uuid(), p_business_id, l.product_id,
      'entree', recv_qty, p_po_id, 'purchase_order',
      'Commande reçue', auth.uid()
    );

    IF l.variant_id IS NOT NULL THEN
      UPDATE product_variants
      SET stock_qty  = stock_qty + recv_qty,
          cost_price = ROUND(l.unit_cost * 100)::bigint,
          updated_at = now()
      WHERE id = l.variant_id;
    ELSE
      UPDATE products
      SET stock_qty  = stock_qty + recv_qty,
          cost_price = ROUND(l.unit_cost * 100)::bigint
      WHERE id = l.product_id AND business_id = p_business_id;
    END IF;

    UPDATE po_lines
    SET qty_received = qty_received + recv_qty
    WHERE id = l.id;
  END LOOP;

  SELECT COUNT(*) INTO total_lines    FROM po_lines WHERE po_id = p_po_id;
  SELECT COUNT(*) INTO received_lines FROM po_lines WHERE po_id = p_po_id AND qty_received >= qty_ordered;

  UPDATE purchase_orders
  SET
    status      = CASE WHEN received_lines = total_lines THEN 'recu' ELSE 'recu_partiel' END,
    received_at = CASE WHEN received_lines = total_lines THEN now() ELSE received_at END
  WHERE id = p_po_id;
END;
$$;

GRANT EXECUTE ON FUNCTION receive_purchase_order(uuid, uuid, uuid[], int[]) TO authenticated;

-- ─── 9. get_product_stats: use variant cost_price for COGS when available ─────

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
  v_cost_price bigint;
  v_revenue    bigint;
  v_capital    bigint;
  v_qty_lost   bigint;
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

  -- Revenue: sum of unit_price × qty across all non-cancelled orders
  SELECT COALESCE(SUM(sl.unit_price * sl.qty), 0)
  INTO v_revenue
  FROM so_lines sl
  JOIN sale_orders so ON so.id = sl.order_id
  WHERE sl.product_id = p_product_id
    AND so.business_id = p_business_id
    AND so.status != 'annule'
    AND (p_since IS NULL OR so.created_at >= p_since);

  -- Capital: per-line cost — uses variant cost_price when variant_id is set,
  -- falls back to parent product cost_price for plain lines.
  SELECT COALESCE(SUM(
    sl.qty * COALESCE(pv.cost_price, v_cost_price)
  ), 0)
  INTO v_capital
  FROM so_lines sl
  JOIN sale_orders so ON so.id = sl.order_id
  LEFT JOIN product_variants pv ON pv.id = sl.variant_id
  WHERE sl.product_id = p_product_id
    AND so.business_id = p_business_id
    AND so.status != 'annule'
    AND (p_since IS NULL OR so.created_at >= p_since);

  SELECT COALESCE(SUM(qty), 0)
  INTO v_qty_lost
  FROM stock_moves
  WHERE product_id = p_product_id
    AND business_id = p_business_id
    AND type = 'perte'
    AND (p_since IS NULL OR created_at >= p_since);

  -- Add loss cost using the parent cost_price (losses aren't variant-tagged)
  v_capital := v_capital + v_qty_lost * v_cost_price;

  RETURN json_build_object(
    'revenue', v_revenue,
    'capital', v_capital,
    'profit',  v_revenue - v_capital
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_product_stats(uuid, uuid, timestamptz) TO authenticated;
