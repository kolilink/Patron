-- ============================================================
-- Patron — Migration v2
-- Run in Supabase SQL Editor AFTER the v1 schema
-- ============================================================

-- ─── Fix profiles RLS: allow team members to see each other's names ───────────
DROP POLICY IF EXISTS "Voir son profil" ON profiles;
DROP POLICY IF EXISTS "Membres: voir profils d'équipe" ON profiles;

CREATE POLICY "Voir son profil" ON profiles FOR SELECT USING (
  auth.uid() = id
  OR EXISTS (
    SELECT 1 FROM memberships m1
    JOIN memberships m2 ON m1.business_id = m2.business_id
    WHERE m1.user_id = auth.uid() AND m2.user_id = profiles.id
  )
);

-- ─── Add 'digital' payment method ────────────────────────────────────────────
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check CHECK (
  method IN ('especes','wave','orange','mtn','moov','credit','digital')
);

-- ─── Add bulk pricing + supplier link to products ────────────────────────────
ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier_id    uuid          REFERENCES suppliers(id);
ALTER TABLE products ADD COLUMN IF NOT EXISTS purchase_date  date;
ALTER TABLE products ADD COLUMN IF NOT EXISTS bulk_price     numeric(15,2);
ALTER TABLE products ADD COLUMN IF NOT EXISTS bulk_min_qty   int;

-- ─── Add sale_date to sale_orders ────────────────────────────────────────────
ALTER TABLE sale_orders ADD COLUMN IF NOT EXISTS sale_date date DEFAULT CURRENT_DATE;

-- ─── Create expenses table ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expenses (
  id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid          NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  amount      numeric(15,2) NOT NULL,
  description text          NOT NULL,
  category    text,
  date        date          NOT NULL DEFAULT CURRENT_DATE,
  status      text          NOT NULL DEFAULT 'approuve'
              CHECK (status IN ('en_attente','approuve','rejete')),
  created_by  uuid          NOT NULL REFERENCES auth.users(id),
  approved_by uuid          REFERENCES auth.users(id),
  approved_at timestamptz,
  created_at  timestamptz   NOT NULL DEFAULT now(),
  updated_at  timestamptz   NOT NULL DEFAULT now()
);

ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Membres: voir les dépenses"             ON expenses;
DROP POLICY IF EXISTS "Membres: créer des dépenses"            ON expenses;
DROP POLICY IF EXISTS "Admins/Managers: approuver des dépenses" ON expenses;

-- All non-investor members can see expenses
CREATE POLICY "Membres: voir les dépenses" ON expenses FOR SELECT USING (
  is_member(business_id) AND get_role(business_id) != 'investisseur'
);

-- Any active member can submit an expense (seller expenses start as 'en_attente')
CREATE POLICY "Membres: créer des dépenses" ON expenses FOR INSERT WITH CHECK (
  get_role(business_id) IN ('administrateur','manager','vendeur')
  AND created_by = auth.uid()
);

-- Only admins/managers can approve or reject
CREATE POLICY "Admins/Managers: approuver des dépenses" ON expenses FOR UPDATE USING (
  get_role(business_id) IN ('administrateur','manager')
);

DROP TRIGGER IF EXISTS trg_expenses_updated_at ON expenses;
CREATE TRIGGER trg_expenses_updated_at
  BEFORE UPDATE ON expenses FOR EACH ROW EXECUTE FUNCTION set_updated_at();
