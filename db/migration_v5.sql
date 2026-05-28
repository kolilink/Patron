-- ============================================================
-- Patron — Migration v5
-- Run in Supabase SQL Editor AFTER migration_v4
-- ============================================================

-- ─── payments: add date, customer_name, business_id ──────────
ALTER TABLE payments ADD COLUMN IF NOT EXISTS date          date;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS customer_name text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS business_id   uuid REFERENCES businesses(id) ON DELETE CASCADE;

-- Backfill date from created_at for all existing rows
UPDATE payments SET date = created_at::date WHERE date IS NULL;

-- Backfill customer_name and business_id from their linked sale_orders
UPDATE payments p
SET customer_name = so.customer_name,
    business_id   = so.business_id
FROM sale_orders so
WHERE p.order_id = so.id
  AND p.customer_name IS NULL;

-- Lock in the date column as non-null after backfill
ALTER TABLE payments ALTER COLUMN date SET NOT NULL;
ALTER TABLE payments ALTER COLUMN date SET DEFAULT CURRENT_DATE;

-- Make order_id nullable so a payment can be attached to a client
-- without referencing a specific order (future FIFO allocation flow)
ALTER TABLE payments ALTER COLUMN order_id DROP NOT NULL;

-- ─── RLS: update policies to handle nullable order_id ────────
DROP POLICY IF EXISTS "Voir paiements"   ON payments;
DROP POLICY IF EXISTS "Insérer paiement" ON payments;

CREATE POLICY "Voir paiements"
  ON payments FOR SELECT
  USING (
    CASE
      WHEN order_id IS NOT NULL
        THEN is_member((SELECT business_id FROM sale_orders WHERE id = order_id))
      ELSE
        business_id IS NOT NULL AND is_member(business_id)
    END
  );

CREATE POLICY "Insérer paiement"
  ON payments FOR INSERT
  WITH CHECK (
    CASE
      WHEN order_id IS NOT NULL
        THEN get_role((SELECT business_id FROM sale_orders WHERE id = order_id))
               IN ('administrateur', 'manager', 'vendeur')
      ELSE
        business_id IS NOT NULL
        AND get_role(business_id) IN ('administrateur', 'manager', 'vendeur')
    END
  );

-- ─── Index for fast client-ledger queries ────────────────────
CREATE INDEX IF NOT EXISTS payments_customer_business_idx
  ON payments (business_id, customer_name);

CREATE INDEX IF NOT EXISTS payments_order_idx
  ON payments (order_id)
  WHERE order_id IS NOT NULL;
