-- ============================================================
-- Patron — Migration v12
-- Run in Supabase SQL Editor AFTER migration_v11
-- ============================================================

-- Allow investisseurs to read sale_orders (read-only observer access).
-- They cannot create, update, or cancel sales.

DROP POLICY IF EXISTS "Membres non-investisseurs: voir les ventes" ON sale_orders;

CREATE POLICY "Membres: voir les ventes"
  ON sale_orders FOR SELECT
  USING (is_member(business_id));

-- so_lines and payments follow sale_orders — investisseurs already can't
-- write, and the existing SELECT policies check via sale_orders join.
-- Update so_lines SELECT policy to allow investisseurs through.

DROP POLICY IF EXISTS "Voir les lignes de vente" ON so_lines;

CREATE POLICY "Voir les lignes de vente"
  ON so_lines FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM sale_orders so
      WHERE so.id = so_lines.order_id
        AND is_member(so.business_id)
    )
  );

-- Allow investisseurs to read expenses (aggregate view for reports).
-- They cannot create or approve expenses.

DROP POLICY IF EXISTS "Membres: voir les dépenses" ON expenses;

CREATE POLICY "Membres: voir les dépenses"
  ON expenses FOR SELECT
  USING (is_member(business_id));

-- Allow investisseurs to read payments (for credit/receivables view).

DROP POLICY IF EXISTS "Membres actifs: voir les paiements" ON payments;
DROP POLICY IF EXISTS "Membres: voir les paiements" ON payments;

CREATE POLICY "Membres: voir les paiements"
  ON payments FOR SELECT
  USING (is_member(business_id));
