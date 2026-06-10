-- migration_v38: give investisseurs read access to sale_orders, expenses, and products
-- Previously only vendeurs (own rows) and admin/manager had SELECT on these tables.
-- Investisseurs are silent observers who need full read access to evaluate the business.

-- ── sale_orders ──────────────────────────────────────────────────────────────
CREATE POLICY "Investisseur: voir toutes les ventes"
  ON sale_orders FOR SELECT TO authenticated
  USING (get_role(business_id) = 'investisseur');

-- ── expenses ─────────────────────────────────────────────────────────────────
CREATE POLICY "Investisseur: voir les dépenses"
  ON expenses FOR SELECT TO authenticated
  USING (get_role(business_id) = 'investisseur');

-- ── products ─────────────────────────────────────────────────────────────────
-- Products may already have an open-member policy; add only if missing.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'products'
      AND policyname ILIKE '%investisseur%'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "Investisseur: voir les produits"
        ON products FOR SELECT TO authenticated
        USING (get_role(business_id) = 'investisseur')
    $policy$;
  END IF;
END $$;
