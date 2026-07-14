-- ============================================================
-- Patron — Migration v68
-- Run in Supabase SQL Editor AFTER migration_v67
--
-- Fix: infinite RLS recursion introduced by v66.
--
-- The v66 investisseur policy on sale_orders contained a subquery
-- on so_lines. But so_lines's existing SELECT policy itself does a
-- subquery on sale_orders to check membership — creating a cycle:
--
--   SELECT sale_orders
--     → evaluate sale_orders RLS (investisseur policy)
--       → SELECT so_lines
--         → evaluate so_lines RLS ("Voir les lignes de vente")
--           → SELECT sale_orders  ← INFINITE RECURSION
--
-- PostgreSQL detects this and raises an error, so ALL direct client
-- queries on sale_orders fail — Ventes and Crédits screens show
-- "Données non disponibles" even when the user is online.
--
-- Fix: wrap the so_lines check in a SECURITY DEFINER function.
-- SECURITY DEFINER bypasses RLS on so_lines, breaking the cycle.
-- ============================================================

-- ─── 1. SECURITY DEFINER helper (bypasses so_lines RLS) ──────────────────────

CREATE OR REPLACE FUNCTION public.investisseur_can_see_order(
  p_order_id    uuid,
  p_business_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM so_lines sl
    JOIN membership_product_scope mps ON mps.product_id = sl.product_id
    JOIN memberships m ON m.id = mps.membership_id
    WHERE sl.order_id  = p_order_id
      AND m.user_id    = auth.uid()
      AND m.business_id = p_business_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.investisseur_can_see_order(uuid, uuid) TO authenticated;

-- ─── 2. Replace the recursive policy on sale_orders ──────────────────────────

DROP POLICY IF EXISTS "Investisseur: voir les ventes (portée)" ON sale_orders;

CREATE POLICY "Investisseur: voir les ventes (portée)"
  ON sale_orders FOR SELECT TO authenticated
  USING (
    get_role(business_id) = 'investisseur'
    AND (
      -- Unscoped investisseur: no rows in membership_product_scope → sees all orders
      NOT EXISTS (
        SELECT 1
        FROM membership_product_scope mps
        JOIN memberships m ON m.id = mps.membership_id
        WHERE m.user_id    = auth.uid()
          AND m.business_id = sale_orders.business_id
      )
      OR
      -- Scoped investisseur: delegate the so_lines check to SECURITY DEFINER helper
      investisseur_can_see_order(sale_orders.id, sale_orders.business_id)
    )
  );
