-- ============================================================
-- Patron — Migration v28
-- Run in Supabase SQL Editor AFTER migration_v27
-- Fix: restrict product write access to admin/manager only.
--
-- Previously, the "Membres actifs: gérer les produits" policy
-- included 'vendeur', giving vendeurs full INSERT/UPDATE/DELETE
-- on products at the DB level — bypassing the frontend guards.
-- ============================================================

DROP POLICY IF EXISTS "Membres actifs: gérer les produits" ON products;

CREATE POLICY "Admin/Manager: gérer les produits"
  ON products FOR ALL USING (
    get_role(business_id) IN ('administrateur', 'manager')
  );
