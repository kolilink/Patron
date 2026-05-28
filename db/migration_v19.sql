-- ============================================================
-- Patron — Migration v19
-- Run in Supabase SQL Editor AFTER migration_v18
-- ============================================================

-- ─── Fix 1: sale_orders — vendeurs see only their own sales ──────────────────
-- The previous policy let any non-investisseur see ALL business sales.
-- Vendeurs must only see sales they created (seller_id = auth.uid()).
-- Managers/Admins keep full visibility.
-- Investisseurs use get_business_kpis() RPC (SECURITY DEFINER) — no direct SELECT needed.

DROP POLICY IF EXISTS "Membres non-investisseurs: voir les ventes" ON sale_orders;

CREATE POLICY "Vendeurs: voir leurs propres ventes"
  ON sale_orders FOR SELECT
  USING (
    get_role(business_id) = 'vendeur'
    AND seller_id = auth.uid()
  );

CREATE POLICY "Managers/Admins: voir toutes les ventes"
  ON sale_orders FOR SELECT
  USING (
    is_member(business_id)
    AND get_role(business_id) IN ('administrateur', 'manager')
  );


-- ─── Fix 2: expenses — vendeurs see only their own expenses ──────────────────
-- The previous policy let any non-investisseur see ALL business expenses.
-- Vendeurs must only see expenses they submitted (created_by = auth.uid()).
-- Managers/Admins see everything so they can approve/reject.

DROP POLICY IF EXISTS "Membres: voir les dépenses" ON expenses;

CREATE POLICY "Vendeurs: voir leurs propres dépenses"
  ON expenses FOR SELECT
  USING (
    get_role(business_id) = 'vendeur'
    AND created_by = auth.uid()
  );

CREATE POLICY "Managers/Admins: voir toutes les dépenses"
  ON expenses FOR SELECT
  USING (
    is_member(business_id)
    AND get_role(business_id) IN ('administrateur', 'manager')
  );
