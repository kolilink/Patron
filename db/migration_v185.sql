-- ============================================================
-- Patron — Migration v185
-- Run in Supabase SQL Editor AFTER migration_v184
--
-- SECURITY FIX (1.14, real enforcement not UI hiding, per direct product
-- decision 2026-09-27): a vendeur's client could read products.cost_price
-- and product_variants.cost_price directly — RLS's base "Membres: voir les
-- produits" / equivalent variants policy is a blanket is_member(business_id)
-- check with no column-level restriction (Postgres RLS is row-level, not
-- column-level, so a view that merely omits a column doesn't stop a direct
-- query against the underlying table for that same column — the base
-- table's own SELECT policy has to actually deny the row to that role).
--
-- Scoped to vendeur only — Patron has no "Observateur" role (the generic
-- checklist's Gérant/Vendeur/Observateur template doesn't map 1:1 onto this
-- app's real roles: administrateur/manager/vendeur/investisseur).
-- investisseur is deliberately NOT touched here: migration_v66.sql already
-- gives investisseur their own separate, scoped SELECT policy specifically
-- so they can verify their own profit-share math on products they hold a
-- stake in — that's a different, already-intentional feature, not the
-- vendeur-visibility gap this migration closes.
--
-- Doesn't touch cost_price's storage or any of the ~50 SQL functions that
-- read/write it (submit_sale, edit_sale, receive_purchase_order,
-- reconciliation, ...) — all of those are SECURITY DEFINER and bypass the
-- caller's own RLS entirely, so narrowing the base tables' SELECT policy
-- has zero effect on them. Only two things change: (1) the base tables'
-- SELECT policy now excludes vendeur, so a raw REST call against
-- products/product_variants returns zero rows for that role; (2) two new
-- SECURITY DEFINER RPCs give vendeur the exact same product/variant data
-- they had before, minus cost_price (returned as 0, not omitted, so the
-- client's existing Product/ProductVariant shape and every arithmetic use
-- of cost_price stays type-correct — no NaN, no optional-field handling
-- needed anywhere else in the app).
-- ============================================================

-- ─── Narrow the base SELECT policies ────────────────────────────────────────

DROP POLICY IF EXISTS "Membres: voir les produits" ON products;
CREATE POLICY "Membres: voir les produits"
  ON products FOR SELECT
  USING (is_member(business_id) AND get_role(business_id) <> 'vendeur');

DROP POLICY IF EXISTS "Membres: voir les variantes" ON product_variants;
CREATE POLICY "Membres: voir les variantes"
  ON product_variants FOR SELECT
  USING (is_member(business_id) AND get_role(business_id) <> 'vendeur');

-- ─── Vendeur's only read path for products/variants ─────────────────────────
-- Each function is its own authorization boundary (SECURITY DEFINER bypasses
-- the caller's RLS entirely) — is_member() is checked explicitly so this
-- can't be used by a non-member to read another business's catalog.

CREATE OR REPLACE FUNCTION public.get_products_for_vendeur(p_business_id uuid)
RETURNS TABLE (
  id uuid, business_id uuid, name text, sku text, category text, unit text,
  cost_price bigint, sale_price bigint, reorder_level numeric, stock_qty numeric,
  archived boolean, archived_at timestamptz, created_at timestamptz, updated_at timestamptz,
  created_by uuid, supplier_id uuid, purchase_date date, bulk_price bigint,
  bulk_min_qty int, is_system boolean, has_variants boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  SELECT
    p.id, p.business_id, p.name, p.sku, p.category, p.unit,
    0::bigint AS cost_price,  -- never the real value — structurally absent, not just unselected
    p.sale_price, p.reorder_level, p.stock_qty,
    p.archived, p.archived_at, p.created_at, p.updated_at,
    p.created_by, p.supplier_id, p.purchase_date, p.bulk_price,
    p.bulk_min_qty, p.is_system, p.has_variants
  FROM products p
  WHERE p.business_id = p_business_id
    AND p.archived = false
    AND p.is_system = false
  ORDER BY p.name;
END;
$$;

REVOKE ALL ON FUNCTION public.get_products_for_vendeur(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_products_for_vendeur(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_variants_for_vendeur(p_product_id uuid, p_business_id uuid)
RETURNS TABLE (
  id uuid, product_id uuid, business_id uuid, name text,
  sale_price bigint, cost_price bigint, stock_qty numeric, reorder_level numeric,
  archived boolean, created_at timestamptz, updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  SELECT
    v.id, v.product_id, v.business_id, v.name,
    v.sale_price, 0::bigint AS cost_price, v.stock_qty, v.reorder_level,
    v.archived, v.created_at, v.updated_at
  FROM product_variants v
  WHERE v.product_id = p_product_id
    AND v.business_id = p_business_id
    AND v.archived = false;
END;
$$;

REVOKE ALL ON FUNCTION public.get_variants_for_vendeur(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_variants_for_vendeur(uuid, uuid) TO authenticated;
