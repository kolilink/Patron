-- ============================================================
-- migration_v243 — idempotent server side for the newly queued offline actions
--
-- The app now records these phone-first and replays them later (outbox):
--   create product, adjust stock, supplier debt payment, supplier debt creation.
-- A replay after a lost response must never double-apply, so:
--
--  1. create_product_with_stock — a product id that already exists IN THIS
--     BUSINESS is a successful replay (returns the id, no error, no second
--     stock move); one that exists in ANOTHER business is refused.
--  2. adjust_stock_move (NEW) — the stock adjustment as ONE atomic, RELATIVE
--     change keyed by the client-generated stock_move id. The old client path
--     wrote an ABSOLUTE stock_qty computed from a possibly stale local value
--     (it would overwrite sales made meanwhile) and its move insert + qty
--     update were two separate calls. Replay of the same move id = no-op.
--  3. pay_supplier_debt — optional p_idempotency_key, stored on the
--     supplier_payments row it logs (partial unique index). A replay returns
--     {remaining_cents: 0, replayed: true} and allocates nothing. The
--     allocation loop and the payment insert share one sub-block, so a
--     concurrent duplicate that loses the race rolls its allocation back.
--
-- Signature change on pay_supplier_debt (3 -> 4 args): the old overload is
-- dropped explicitly (CREATE OR REPLACE alone would leave an ambiguous second
-- overload — see migration_v132/v186). All three pin search_path to
-- public, pg_temp (v233) and are callable by authenticated only.
-- ============================================================

-- ── 1. create_product_with_stock: idempotent ────────────────────────────────
CREATE OR REPLACE FUNCTION create_product_with_stock(
  p_product    jsonb,
  p_stock_move jsonb DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_product_id  uuid := (p_product->>'id')::uuid;
  v_business_id uuid := (p_product->>'business_id')::uuid;
BEGIN
  IF get_role(v_business_id) IS NULL OR get_role(v_business_id) NOT IN ('administrateur', 'manager') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  -- [v243] replay of an already-created product (the first attempt landed and
  -- only its response was lost) is success; the same id in another business is not.
  IF EXISTS (SELECT 1 FROM products WHERE id = v_product_id) THEN
    IF EXISTS (SELECT 1 FROM products WHERE id = v_product_id AND business_id = v_business_id) THEN
      RETURN v_product_id;
    END IF;
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO products (
    id, business_id, name, sku, category, unit,
    cost_price, sale_price, reorder_level, stock_qty, archived,
    supplier_id, purchase_date, bulk_price, bulk_min_qty, created_by
  ) VALUES (
    v_product_id,
    v_business_id,
    p_product->>'name',
    p_product->>'sku',
    p_product->>'category',
    p_product->>'unit',
    (p_product->>'cost_price')::numeric,
    (p_product->>'sale_price')::numeric,
    (p_product->>'reorder_level')::numeric,
    (p_product->>'stock_qty')::numeric,
    (p_product->>'archived')::boolean,
    (p_product->>'supplier_id')::uuid,
    (p_product->>'purchase_date')::date,
    (p_product->>'bulk_price')::numeric,
    (p_product->>'bulk_min_qty')::numeric,
    (p_product->>'created_by')::uuid
  );

  IF p_stock_move IS NOT NULL THEN
    -- business_id/created_by are forced to the already-validated values (v196).
    INSERT INTO stock_moves (
      id, business_id, product_id, type, qty, ref_id, ref_type, note, created_by
    ) VALUES (
      (p_stock_move->>'id')::uuid,
      v_business_id,
      v_product_id,
      p_stock_move->>'type',
      (p_stock_move->>'qty')::numeric,
      (p_stock_move->>'ref_id')::uuid,
      p_stock_move->>'ref_type',
      p_stock_move->>'note',
      auth.uid()
    )
    ON CONFLICT (id) DO NOTHING;
  END IF;

  RETURN v_product_id;
END;
$$;

GRANT EXECUTE ON FUNCTION create_product_with_stock(jsonb, jsonb) TO authenticated;
REVOKE EXECUTE ON FUNCTION create_product_with_stock(jsonb, jsonb) FROM PUBLIC, anon;

-- ── 2. adjust_stock_move (new): atomic, relative, keyed by the move id ──────
CREATE OR REPLACE FUNCTION public.adjust_stock_move(
  p_business_id uuid,
  p_product_id  uuid,
  p_type        text,       -- 'entree' (adds) | 'perte' | 'sortie' (remove)
  p_qty         numeric,
  p_note        text DEFAULT NULL,
  p_move_id     uuid DEFAULT NULL
)
RETURNS numeric              -- the product's stock_qty after the call
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_move_id uuid := COALESCE(p_move_id, gen_random_uuid());
  v_qty     numeric;
  v_sign    int;
BEGIN
  IF get_role(p_business_id) IS NULL OR get_role(p_business_id) NOT IN ('administrateur', 'manager') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF p_type NOT IN ('entree', 'perte', 'sortie') THEN
    RAISE EXCEPTION 'Type de mouvement invalide' USING ERRCODE = 'P0001';
  END IF;
  IF p_qty IS NULL OR p_qty <= 0 THEN
    RAISE EXCEPTION 'Quantité invalide' USING ERRCODE = 'P0001';
  END IF;

  -- The product must belong to THIS business (definer bypasses RLS: nothing
  -- else stops a foreign product id — see the v195/v196 sweeps).
  IF NOT EXISTS (SELECT 1 FROM products WHERE id = p_product_id AND business_id = p_business_id) THEN
    RAISE EXCEPTION 'Produit introuvable' USING ERRCODE = 'P0001';
  END IF;

  v_sign := CASE WHEN p_type = 'entree' THEN 1 ELSE -1 END;

  -- Claim the move id first; a replay inserts nothing and changes nothing.
  INSERT INTO stock_moves (id, business_id, product_id, type, qty, ref_id, ref_type, note, created_by)
  VALUES (v_move_id, p_business_id, p_product_id, p_type, p_qty, NULL, 'manuel', p_note, auth.uid())
  ON CONFLICT (id) DO NOTHING;

  IF FOUND THEN
    UPDATE products
       SET stock_qty = GREATEST(0, stock_qty + v_sign * p_qty)
     WHERE id = p_product_id AND business_id = p_business_id
    RETURNING stock_qty INTO v_qty;
  ELSE
    SELECT stock_qty INTO v_qty FROM products WHERE id = p_product_id AND business_id = p_business_id;
  END IF;

  RETURN v_qty;
END;
$$;

GRANT EXECUTE ON FUNCTION public.adjust_stock_move(uuid, uuid, text, numeric, text, uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.adjust_stock_move(uuid, uuid, text, numeric, text, uuid) FROM PUBLIC, anon;

-- ── 3. pay_supplier_debt: idempotency key ───────────────────────────────────
ALTER TABLE public.supplier_payments ADD COLUMN IF NOT EXISTS idempotency_key uuid;
CREATE UNIQUE INDEX IF NOT EXISTS supplier_payments_idempotency_key_key
  ON public.supplier_payments (idempotency_key) WHERE idempotency_key IS NOT NULL;

DROP FUNCTION IF EXISTS public.pay_supplier_debt(uuid, uuid, bigint);

CREATE OR REPLACE FUNCTION public.pay_supplier_debt(
  p_business_id     uuid,
  p_supplier_id     uuid,
  p_amount_cents    bigint,
  p_idempotency_key uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_remaining   bigint := p_amount_cents;
  v_allocated   bigint := 0;
  v_debt        record;
  v_outstanding bigint;
  v_paying      bigint;
BEGIN
  IF get_role(p_business_id) IS NULL OR get_role(p_business_id) NOT IN ('administrateur', 'manager') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'Le montant doit être positif' USING ERRCODE = 'P0001';
  END IF;

  -- [v243] replay of a payment that already landed: nothing to allocate.
  IF p_idempotency_key IS NOT NULL
     AND EXISTS (SELECT 1 FROM supplier_payments WHERE idempotency_key = p_idempotency_key) THEN
    RETURN jsonb_build_object('remaining_cents', 0, 'replayed', true);
  END IF;

  BEGIN
    -- FOR UPDATE locks each debt row before reading its balance,
    -- preventing concurrent double-payment on the same debt.
    FOR v_debt IN
      SELECT id, amount, amount_paid
      FROM supplier_debts
      WHERE business_id = p_business_id
        AND supplier_id = p_supplier_id
        AND amount      > amount_paid
      ORDER BY created_at ASC
      FOR UPDATE
    LOOP
      IF v_remaining <= 0 THEN EXIT; END IF;

      v_outstanding := v_debt.amount - v_debt.amount_paid;
      v_paying      := LEAST(v_remaining, v_outstanding);

      UPDATE supplier_debts
      SET amount_paid = amount_paid + v_paying
      WHERE id = v_debt.id;

      v_remaining := v_remaining - v_paying;
      v_allocated := v_allocated + v_paying;
    END LOOP;

    -- Log only what was actually allocated (not the requested amount).
    IF v_allocated > 0 THEN
      INSERT INTO public.supplier_payments (business_id, supplier_id, amount_cents, paid_by, idempotency_key)
      VALUES (p_business_id, p_supplier_id, v_allocated, auth.uid(), p_idempotency_key);
    END IF;
  EXCEPTION WHEN unique_violation THEN
    -- A concurrent call with the same key won the race: this block's debt
    -- allocation is rolled back with the sub-transaction.
    RETURN jsonb_build_object('remaining_cents', 0, 'replayed', true);
  END;

  RETURN jsonb_build_object('remaining_cents', v_remaining);
END;
$$;

GRANT EXECUTE ON FUNCTION public.pay_supplier_debt(uuid, uuid, bigint, uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.pay_supplier_debt(uuid, uuid, bigint, uuid) FROM PUBLIC, anon;
