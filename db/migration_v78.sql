-- ============================================================
-- Patron — Migration v78
-- Run in Supabase SQL Editor AFTER migration_v77
--
-- Investor profit-sharing system:
--   1. investor_balance  — running profit balance per investor per business
--   2. investor_payouts  — withdrawal requests and manager payment records
--   3. request_payout    — investor RPC: submit a withdrawal request
--   4. confirm_payout    — admin/manager RPC: record actual payment (partial or full)
--   5. submit_sale       — recreated to accumulate investor profit shares per sale
-- ============================================================

-- ─── 1. investor_balance ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS investor_balance (
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  investor_id  uuid NOT NULL REFERENCES profiles(id)   ON DELETE CASCADE,
  balance      bigint NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, investor_id)
);

ALTER TABLE investor_balance ENABLE ROW LEVEL SECURITY;

-- Admin, manager, and the investor themselves can read
CREATE POLICY "investor_balance_select"
  ON investor_balance FOR SELECT
  USING (
    is_member(business_id) AND (
      get_role(business_id) IN ('administrateur', 'manager')
      OR investor_id = auth.uid()
    )
  );

-- No direct writes — only via RPCs (SECURITY DEFINER bypasses RLS)

-- ─── 2. investor_payouts ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS investor_payouts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  investor_id      uuid NOT NULL REFERENCES profiles(id)   ON DELETE CASCADE,
  requested_amount bigint NOT NULL CHECK (requested_amount > 0),
  paid_amount      bigint CHECK (paid_amount > 0),
  status           text NOT NULL DEFAULT 'en_attente'
                     CHECK (status IN ('en_attente', 'paye')),
  requested_at     timestamptz NOT NULL DEFAULT now(),
  paid_at          timestamptz,
  paid_by          uuid REFERENCES profiles(id)
);

ALTER TABLE investor_payouts ENABLE ROW LEVEL SECURITY;

-- Admin, manager, and the investor themselves can read
CREATE POLICY "investor_payouts_select"
  ON investor_payouts FOR SELECT
  USING (
    is_member(business_id) AND (
      get_role(business_id) IN ('administrateur', 'manager')
      OR investor_id = auth.uid()
    )
  );

-- No direct writes — only via RPCs

-- ─── 3. request_payout RPC ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.request_payout(
  p_business_id uuid,
  p_amount      bigint
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance    bigint;
  v_payout_id  uuid;
BEGIN
  -- Must be an investor in this business
  IF get_role(p_business_id) != 'investisseur' THEN
    RAISE EXCEPTION 'Seuls les investisseurs peuvent faire une demande de retrait' USING ERRCODE = 'P0001';
  END IF;

  -- Fetch current balance
  SELECT balance INTO v_balance
  FROM investor_balance
  WHERE business_id = p_business_id AND investor_id = auth.uid();

  IF v_balance IS NULL OR v_balance = 0 THEN
    RAISE EXCEPTION 'Vous n''avez pas de solde disponible' USING ERRCODE = 'P0001';
  END IF;

  IF p_amount > v_balance THEN
    RAISE EXCEPTION 'Le montant demandé dépasse votre solde disponible' USING ERRCODE = 'P0001';
  END IF;

  -- Only one pending request at a time
  IF EXISTS (
    SELECT 1 FROM investor_payouts
    WHERE business_id = p_business_id
      AND investor_id = auth.uid()
      AND status = 'en_attente'
  ) THEN
    RAISE EXCEPTION 'Vous avez déjà une demande en attente' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO investor_payouts (business_id, investor_id, requested_amount)
  VALUES (p_business_id, auth.uid(), p_amount)
  RETURNING id INTO v_payout_id;

  RETURN v_payout_id;
END;
$$;

REVOKE ALL ON FUNCTION public.request_payout(uuid, bigint) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_payout(uuid, bigint) TO authenticated;

-- ─── 4. confirm_payout RPC ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.confirm_payout(
  p_payout_id   uuid,
  p_paid_amount bigint
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payout investor_payouts%ROWTYPE;
BEGIN
  SELECT * INTO v_payout FROM investor_payouts WHERE id = p_payout_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Demande introuvable' USING ERRCODE = 'P0001';
  END IF;

  IF get_role(v_payout.business_id) NOT IN ('administrateur', 'manager') THEN
    RAISE EXCEPTION 'Action non autorisée' USING ERRCODE = 'P0001';
  END IF;

  IF v_payout.status != 'en_attente' THEN
    RAISE EXCEPTION 'Cette demande a déjà été traitée' USING ERRCODE = 'P0001';
  END IF;

  IF p_paid_amount > v_payout.requested_amount THEN
    RAISE EXCEPTION 'Le montant payé ne peut pas dépasser le montant demandé' USING ERRCODE = 'P0001';
  END IF;

  UPDATE investor_payouts
  SET paid_amount = p_paid_amount,
      status      = 'paye',
      paid_at     = now(),
      paid_by     = auth.uid()
  WHERE id = p_payout_id;

  -- Deduct from balance (floor at 0 to guard against any race)
  UPDATE investor_balance
  SET balance    = GREATEST(0, balance - p_paid_amount),
      updated_at = now()
  WHERE business_id = v_payout.business_id
    AND investor_id  = v_payout.investor_id;
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_payout(uuid, bigint) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_payout(uuid, bigint) TO authenticated;

-- ─── 5. submit_sale — add investor balance accumulation ──────────────────────
-- Full recreate of v67 submit_sale with profit-share accumulation appended
-- inside the stock-move loop.

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
  v_order_id        uuid;
  v_item            jsonb;
  v_membership_id   uuid;
  v_has_scope       boolean;
  v_cost_price      bigint;
  v_line_profit     bigint;
  v_investor        RECORD;
BEGIN
  -- Role gate
  IF get_role(p_business_id) NOT IN ('administrateur', 'manager', 'vendeur') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  -- Vendeurs can only submit sales in their own name
  IF get_role(p_business_id) = 'vendeur' AND p_seller_id != auth.uid() THEN
    RAISE EXCEPTION 'Un vendeur ne peut enregistrer que ses propres ventes' USING ERRCODE = 'P0001';
  END IF;

  -- Vendeur product scope check
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

  -- Idempotency
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
    INSERT INTO so_lines (id, order_id, product_id, product_name, qty, unit_price, is_bulk, variant_id, variant_name)
    VALUES (
      gen_random_uuid(), v_order_id,
      (v_item->>'product_id')::uuid,
      v_item->>'product_name',
      (v_item->>'qty')::numeric,
      (v_item->>'unit_price')::numeric,
      coalesce((v_item->>'is_bulk')::boolean, false),
      nullif(v_item->>'variant_id', '')::uuid,
      nullif(v_item->>'variant_name', '')
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

    UPDATE products
    SET stock_qty = GREATEST(0, stock_qty - (v_item->>'qty')::numeric)
    WHERE id = (v_item->>'product_id')::uuid;

    -- ── Investor profit accumulation ──────────────────────────────────────
    -- Resolve cost price: variant first, fall back to parent product
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

    v_line_profit := GREATEST(0,
      ((v_item->>'unit_price')::bigint - coalesce(v_cost_price, 0))
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
    -- ─────────────────────────────────────────────────────────────────────
  END LOOP;

  RETURN v_order_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_sale(uuid,uuid,text,date,numeric,numeric,boolean,jsonb,text,numeric,text,uuid,uuid,date) TO authenticated;
