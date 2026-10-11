-- ============================================================
-- migration_v244 — offline supplier creation via outbox
--
-- Problem: handleSaveFournisseur did a direct Supabase INSERT into
-- suppliers, so an offline merchant (market vendors in particular) could
-- not create a supplier — including the inline "+ Nouveau fournisseur" in
-- the reception picker. Supplier creation must be phone-first.
--
-- The app now records these writes phone-first and replays them later
-- (outbox) through ONE server-side function, so the supplier, its brand-new
-- products and its product links are all applied atomically (no split client
-- writes):
--
--   upsert_supplier(p_supplier, p_new_products, p_link_product_ids,
--                   p_unlink_product_ids, p_is_edit)
--
-- Idempotency (a replay after a lost response must never double-apply):
--   * create (p_is_edit = false): INSERT ... ON CONFLICT (id) DO NOTHING —
--     a supplier id that already exists IN THIS BUSINESS is a successful
--     replay (returns the id); one that exists in ANOTHER business is
--     refused. The outbox idempotency key is the supplier id, so the
--     23505-like path never double-inserts.
--   * edit (p_is_edit = true): UPDATE suppliers ... WHERE id AND business_id.
--     The same id being edited twice is naturally idempotent.
--   * new products carry client-generated ids and insert with
--     ON CONFLICT (id) DO NOTHING; an id already in another business is
--     refused (same ownership rule as create_product_with_stock, v243).
--   * link/unlink of existing product ids are validated to this business
--     before the UPDATE.
--
-- The RPC pins search_path to public, pg_temp (v233) and is callable by
-- authenticated only; the same administrateur/manager gate as the suppliers
-- RLS policy and the v243 supplier-debt functions.
-- ============================================================

CREATE OR REPLACE FUNCTION public.upsert_supplier(
  p_supplier           jsonb,
  p_new_products       jsonb   DEFAULT '[]',
  p_link_product_ids   uuid[]  DEFAULT '{}',
  p_unlink_product_ids uuid[]  DEFAULT '{}',
  p_is_edit            boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_supplier_id uuid := (p_supplier->>'id')::uuid;
  v_business_id uuid := (p_supplier->>'business_id')::uuid;
  v_name        text := nullif(trim(p_supplier->>'name'), '');
  v_item        record;
  v_product_id  uuid;
BEGIN
  IF get_role(v_business_id) IS NULL OR get_role(v_business_id) NOT IN ('administrateur', 'manager') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF v_name IS NULL THEN
    RAISE EXCEPTION 'Le nom du fournisseur est requis' USING ERRCODE = 'P0001';
  END IF;

  IF p_is_edit THEN
    -- Update-by-id: must already exist in THIS business (definer bypasses
    -- RLS, so ownership is checked explicitly — see the v195/v196 sweeps).
    UPDATE suppliers
       SET name       = v_name,
           phone      = nullif(p_supplier->>'phone', ''),
           country    = nullif(p_supplier->>'country', ''),
           lead_days  = nullif(p_supplier->>'lead_days', '')::int,
           notes      = nullif(p_supplier->>'notes', ''),
           updated_at = now()
     WHERE id = v_supplier_id AND business_id = v_business_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Fournisseur introuvable' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    -- [v244] replay of an already-created supplier (the first attempt landed
    -- and only its response was lost) is success; the same id in another
    -- business is not.
    IF EXISTS (SELECT 1 FROM suppliers WHERE id = v_supplier_id) THEN
      IF EXISTS (SELECT 1 FROM suppliers WHERE id = v_supplier_id AND business_id = v_business_id) THEN
        RETURN v_supplier_id;
      END IF;
      RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO suppliers (id, business_id, name, phone, country, lead_days, notes, created_by)
    VALUES (
      v_supplier_id,
      v_business_id,
      v_name,
      nullif(p_supplier->>'phone', ''),
      nullif(p_supplier->>'country', ''),
      nullif(p_supplier->>'lead_days', '')::int,
      nullif(p_supplier->>'notes', ''),
      (p_supplier->>'created_by')::uuid
    )
    ON CONFLICT (id) DO NOTHING;
  END IF;

  -- New products created together with the supplier (client-generated ids).
  -- Created once, linked atomically; replay inserts nothing.
  IF p_new_products IS NOT NULL AND jsonb_typeof(p_new_products) = 'array' THEN
    FOR v_item IN SELECT value AS item FROM jsonb_array_elements(p_new_products) LOOP
      v_product_id := (v_item.item->>'id')::uuid;
      IF EXISTS (SELECT 1 FROM products WHERE id = v_product_id AND business_id <> v_business_id) THEN
        RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
      END IF;

      INSERT INTO products (
        id, business_id, name, unit, cost_price, sale_price,
        reorder_level, stock_qty, archived, supplier_id, created_by
      ) VALUES (
        v_product_id,
        v_business_id,
        v_item.item->>'name',
        coalesce(nullif(v_item.item->>'unit', ''), 'pcs'),
        0, 0, 0, 0, false,
        v_supplier_id,
        (p_supplier->>'created_by')::uuid
      )
      ON CONFLICT (id) DO NOTHING;
    END LOOP;
  END IF;

  -- Link existing products to this supplier. Every id must already belong to
  -- this business (a foreign product id is refused, not silently ignored).
  IF EXISTS (
    SELECT 1 FROM unnest(p_link_product_ids) AS pid
    WHERE NOT EXISTS (SELECT 1 FROM products WHERE id = pid AND business_id = v_business_id)
  ) THEN
    RAISE EXCEPTION 'Produit introuvable' USING ERRCODE = 'P0001';
  END IF;

  UPDATE products
     SET supplier_id = v_supplier_id
   WHERE id = ANY(p_link_product_ids) AND business_id = v_business_id;

  -- Unlink products deselected on the supplier form.
  IF EXISTS (
    SELECT 1 FROM unnest(p_unlink_product_ids) AS pid
    WHERE NOT EXISTS (SELECT 1 FROM products WHERE id = pid AND business_id = v_business_id)
  ) THEN
    RAISE EXCEPTION 'Produit introuvable' USING ERRCODE = 'P0001';
  END IF;

  UPDATE products
     SET supplier_id = NULL
   WHERE id = ANY(p_unlink_product_ids) AND business_id = v_business_id;

  RETURN v_supplier_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_supplier(jsonb, jsonb, uuid[], uuid[], boolean) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.upsert_supplier(jsonb, jsonb, uuid[], uuid[], boolean) FROM PUBLIC, anon;
