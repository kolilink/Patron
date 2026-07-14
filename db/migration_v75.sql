-- v75: Many-to-many product-supplier links
-- Allows one product to be supplied by multiple suppliers and vice-versa.

CREATE TABLE IF NOT EXISTS product_suppliers (
  product_id  UUID NOT NULL REFERENCES products(id)  ON DELETE CASCADE,
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, supplier_id)
);

ALTER TABLE product_suppliers ENABLE ROW LEVEL SECURITY;

-- Any business member can read the links for their own products
CREATE POLICY "membres lire liens produits-fournisseurs" ON product_suppliers
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM products p
      JOIN memberships m ON m.business_id = p.business_id AND m.user_id = auth.uid()
      WHERE p.id = product_suppliers.product_id
    )
  );

-- Only admin/manager can add or remove links
CREATE POLICY "admin_manager insérer liens" ON product_suppliers
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM products p
      JOIN memberships m ON m.business_id = p.business_id AND m.user_id = auth.uid()
      WHERE p.id = product_suppliers.product_id
        AND m.role IN ('administrateur', 'manager')
    )
  );

CREATE POLICY "admin_manager supprimer liens" ON product_suppliers
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM products p
      JOIN memberships m ON m.business_id = p.business_id AND m.user_id = auth.uid()
      WHERE p.id = product_suppliers.product_id
        AND m.role IN ('administrateur', 'manager')
    )
  );

-- Backfill existing single-supplier links from products.supplier_id
INSERT INTO product_suppliers (product_id, supplier_id)
SELECT id, supplier_id FROM products WHERE supplier_id IS NOT NULL
ON CONFLICT DO NOTHING;
