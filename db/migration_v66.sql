-- migration_v66: product-scoped member access
-- Adds membership_product_scope table and updates investisseur RLS to respect scope.
-- No scope rows for a member = unchanged behaviour (sees everything).
-- Has scope rows = access restricted to those products only.

-- ─── New table ────────────────────────────────────────────────────────────────

CREATE TABLE membership_product_scope (
  id            uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  membership_id uuid           NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  product_id    uuid           NOT NULL REFERENCES products(id)    ON DELETE CASCADE,
  contribution  bigint         NOT NULL DEFAULT 0,    -- GNF cents ×100
  profit_share  numeric(5,2)   NOT NULL DEFAULT 0,    -- 0.00–100.00 %
  created_at    timestamptz    NOT NULL DEFAULT now(),
  UNIQUE (membership_id, product_id)
);

ALTER TABLE membership_product_scope ENABLE ROW LEVEL SECURITY;

-- Admin/Manager of the business manages all scope rows for their business
CREATE POLICY "Admin/Manager: gérer portées produits"
  ON membership_product_scope FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.id = membership_id
        AND get_role(m.business_id) IN ('administrateur', 'manager')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.id = membership_id
        AND get_role(m.business_id) IN ('administrateur', 'manager')
    )
  );

-- Each member can read their own scope rows
CREATE POLICY "Membre: voir sa portée produits"
  ON membership_product_scope FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.id = membership_id AND m.user_id = auth.uid()
    )
  );

-- ─── Indexes ─────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_mps_membership_id ON membership_product_scope(membership_id);
CREATE INDEX IF NOT EXISTS idx_mps_product_id    ON membership_product_scope(product_id);

-- ─── Update investisseur RLS on sale_orders ───────────────────────────────────
-- Old v38 policy gave blanket SELECT to investisseurs. New: if no scope rows
-- exist the investisseur still sees everything; if scope rows exist, only see
-- orders that contain at least one of their scoped products.

DROP POLICY IF EXISTS "Investisseur: voir toutes les ventes" ON sale_orders;

CREATE POLICY "Investisseur: voir les ventes (portée)"
  ON sale_orders FOR SELECT TO authenticated
  USING (
    get_role(business_id) = 'investisseur'
    AND (
      -- Unscoped: no rows in membership_product_scope for this user+business
      NOT EXISTS (
        SELECT 1 FROM membership_product_scope mps
        JOIN memberships m ON m.id = mps.membership_id
        WHERE m.user_id = auth.uid()
          AND m.business_id = sale_orders.business_id
      )
      OR
      -- Scoped: at least one so_line references a scoped product
      EXISTS (
        SELECT 1 FROM so_lines sl
        JOIN membership_product_scope mps ON mps.product_id = sl.product_id
        JOIN memberships m ON m.id = mps.membership_id
        WHERE sl.order_id = sale_orders.id
          AND m.user_id = auth.uid()
          AND m.business_id = sale_orders.business_id
      )
    )
  );

-- ─── Update investisseur RLS on products ─────────────────────────────────────

DROP POLICY IF EXISTS "Investisseur: voir les produits" ON products;

CREATE POLICY "Investisseur: voir les produits (portée)"
  ON products FOR SELECT TO authenticated
  USING (
    get_role(business_id) = 'investisseur'
    AND (
      NOT EXISTS (
        SELECT 1 FROM membership_product_scope mps
        JOIN memberships m ON m.id = mps.membership_id
        WHERE m.user_id = auth.uid()
          AND m.business_id = products.business_id
      )
      OR
      EXISTS (
        SELECT 1 FROM membership_product_scope mps
        JOIN memberships m ON m.id = mps.membership_id
        WHERE mps.product_id = products.id
          AND m.user_id = auth.uid()
          AND m.business_id = products.business_id
      )
    )
  );

-- ─── Update investisseur RLS on expenses ─────────────────────────────────────
-- Expenses have no product_id FK. Scoped investisseurs see NO expenses
-- (clean separation — only unscoped investisseurs see expenses, unchanged from v38).

DROP POLICY IF EXISTS "Investisseur: voir les dépenses" ON expenses;

CREATE POLICY "Investisseur: voir les dépenses (portée)"
  ON expenses FOR SELECT TO authenticated
  USING (
    get_role(business_id) = 'investisseur'
    AND NOT EXISTS (
      SELECT 1 FROM membership_product_scope mps
      JOIN memberships m ON m.id = mps.membership_id
      WHERE m.user_id = auth.uid()
        AND m.business_id = expenses.business_id
    )
  );
