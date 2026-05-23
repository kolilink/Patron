-- ============================================================
-- Patron — Migration v4
-- Run in Supabase SQL Editor AFTER migration_v3
-- ============================================================

-- ─── sale_orders: cancellation fields ────────────────────────
ALTER TABLE sale_orders ADD COLUMN IF NOT EXISTS cancelled_at         timestamptz;
ALTER TABLE sale_orders ADD COLUMN IF NOT EXISTS cancellation_reason  text;

-- ─── products: archive timestamp ─────────────────────────────
ALTER TABLE products ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- ─── clients table ───────────────────────────────────────────
-- Stores supplemental client info (phone, notes) keyed by business + name.
-- The primary client identity is still customer_name on sale_orders.
CREATE TABLE IF NOT EXISTS clients (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name        text        NOT NULL,
  phone       text,
  notes       text,
  created_by  uuid        REFERENCES auth.users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, name)
);

ALTER TABLE clients ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Voir clients"     ON clients;
DROP POLICY IF EXISTS "Créer client"     ON clients;
DROP POLICY IF EXISTS "Modifier client"  ON clients;
DROP POLICY IF EXISTS "Supprimer client" ON clients;

CREATE POLICY "Voir clients"
  ON clients FOR SELECT
  USING (is_member(business_id));

CREATE POLICY "Créer client"
  ON clients FOR INSERT
  WITH CHECK (is_member(business_id));

CREATE POLICY "Modifier client"
  ON clients FOR UPDATE
  USING (is_member(business_id));

CREATE POLICY "Supprimer client"
  ON clients FOR DELETE
  USING (get_role(business_id) IN ('administrateur', 'manager'));
