-- ============================================================
-- Patron — Migration v22
-- Run in Supabase SQL Editor AFTER migration_v21
-- Patches: M-1 (get_best_sellers RPC), M-3 (submit_sale + cancel_sale
--          RPCs + retrait du rôle vendeur de stock_moves INSERT)
-- ============================================================

-- ─── M-1: RPC get_best_sellers ────────────────────────────────────────────────
-- Remplace le double balayage sale_orders → so_lines dans le tableau de bord.
-- Coût réseau : 5 lignes retournées au lieu de potentiellement 50 000.

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
    p.name        AS product_name,
    SUM(sl.qty)              AS total_qty,
    SUM(sl.qty * sl.unit_price) AS total_revenue
  FROM so_lines sl
  JOIN products p    ON p.id  = sl.product_id
  JOIN sale_orders so ON so.id = sl.order_id
  WHERE so.business_id = p_business_id
    AND so.status IN ('paye', 'credit')
    AND so.sale_date >= p_month_start
  GROUP BY sl.product_id, p.name
  ORDER BY total_revenue DESC
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION public.get_best_sellers(uuid, date, int) TO authenticated;


-- ─── M-3a: RPC submit_sale ────────────────────────────────────────────────────
-- Regroupe la création de sale_order + so_lines + payment + stock_moves en une
-- seule transaction SECURITY DEFINER. Les vendeurs n'ont plus besoin d'INSERT
-- direct sur stock_moves — c'est cette fonction qui s'en charge.
-- Les mises à jour de stock sont best-effort (non bloquantes si elles échouent).

CREATE OR REPLACE FUNCTION public.submit_sale(
  p_business_id     uuid,
  p_seller_id       uuid,
  p_customer_name   text,
  p_sale_date       date,
  p_total_amount    numeric,
  p_discount_amount numeric,
  p_is_credit       boolean,
  p_cart            jsonb,
  p_pay_method      text    DEFAULT NULL,
  p_pay_amount      numeric DEFAULT NULL,
  p_pay_ref         text    DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order_id uuid := gen_random_uuid();
  v_item     jsonb;
BEGIN
  -- Vérifie que l'appelant a le droit de créer des ventes
  IF get_role(p_business_id) NOT IN ('administrateur', 'manager', 'vendeur') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  -- Un vendeur ne peut créer des ventes qu'en son propre nom
  IF get_role(p_business_id) = 'vendeur' AND p_seller_id != auth.uid() THEN
    RAISE EXCEPTION 'Un vendeur ne peut enregistrer que ses propres ventes' USING ERRCODE = 'P0001';
  END IF;

  -- 1. Créer la commande
  INSERT INTO sale_orders (
    id, business_id, customer_name, seller_id, status, is_credit,
    paid_at, sale_date, total_amount, discount_amount, created_by
  ) VALUES (
    v_order_id,
    p_business_id,
    nullif(trim(coalesce(p_customer_name, '')), ''),
    p_seller_id,
    CASE WHEN p_is_credit THEN 'credit' ELSE 'paye' END,
    p_is_credit,
    CASE WHEN p_is_credit THEN NULL ELSE now() END,
    p_sale_date,
    p_total_amount,
    p_discount_amount,
    auth.uid()
  );

  -- 2. Créer les lignes de vente
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_cart) LOOP
    INSERT INTO so_lines (id, order_id, product_id, qty, unit_price, is_bulk)
    VALUES (
      gen_random_uuid(),
      v_order_id,
      (v_item->>'product_id')::uuid,
      (v_item->>'qty')::numeric,
      (v_item->>'unit_price')::numeric,
      coalesce((v_item->>'is_bulk')::boolean, false)
    );
  END LOOP;

  -- 3. Enregistrer le paiement si applicable
  IF p_pay_method IS NOT NULL AND p_pay_amount IS NOT NULL AND p_pay_amount > 0 THEN
    INSERT INTO payments (id, order_id, customer_name, business_id, method, amount, date, ref_external)
    VALUES (
      gen_random_uuid(),
      v_order_id,
      nullif(trim(coalesce(p_customer_name, '')), ''),
      p_business_id,
      p_pay_method,
      p_pay_amount,
      p_sale_date,
      nullif(trim(coalesce(p_pay_ref, '')), '')
    );
  END IF;

  -- 4. Déduction du stock (best-effort : la vente reste validée même en cas d'échec)
  BEGIN
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

      UPDATE products
      SET stock_qty = GREATEST(0, stock_qty - (v_item->>'qty')::numeric)
      WHERE id = (v_item->>'product_id')::uuid;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    NULL; -- Non-fatal : la vente est validée, la dérive de stock est corrigée au prochain inventaire
  END;

  RETURN v_order_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_sale(uuid, uuid, text, date, numeric, numeric, boolean, jsonb, text, numeric, text) TO authenticated;


-- ─── M-3b: RPC cancel_sale ────────────────────────────────────────────────────
-- Annule une vente et restaure le stock via la même approche SECURITY DEFINER.
-- Les vendeurs ne peuvent annuler que leurs propres ventes.

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

  -- Marquer comme annulée
  UPDATE sale_orders
  SET status = 'annule',
      cancelled_at = now(),
      cancellation_reason = p_reason
  WHERE id = p_sale_id;

  -- Restauration du stock (best-effort)
  BEGIN
    FOR v_line IN SELECT product_id, qty FROM so_lines WHERE order_id = p_sale_id LOOP
      INSERT INTO stock_moves (
        id, business_id, product_id, type, qty, ref_id, ref_type, note, created_by
      ) VALUES (
        gen_random_uuid(), p_business_id, v_line.product_id,
        'entree', v_line.qty, p_sale_id, 'annulation',
        'Annulation: ' || coalesce(p_reason, ''), auth.uid()
      );

      UPDATE products
      SET stock_qty = stock_qty + v_line.qty
      WHERE id = v_line.product_id;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_sale(uuid, uuid, text) TO authenticated;


-- ─── M-3c: Retrait du rôle vendeur de stock_moves INSERT ─────────────────────
-- Les vendeurs passaient par l'insertion directe (contournable).
-- Désormais, toutes les opérations de stock passent par les RPCs SECURITY DEFINER
-- ci-dessus, qui effectuent les vérifications de sécurité en amont.

DROP POLICY IF EXISTS "Membres actifs: créer des mouvements" ON stock_moves;

CREATE POLICY "Admins/Managers: créer des mouvements"
  ON stock_moves FOR INSERT
  WITH CHECK (
    get_role(business_id) IN ('administrateur', 'manager')
  );
