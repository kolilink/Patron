-- ============================================================
-- Patron — Migration v7
-- Run in Supabase SQL Editor AFTER migration_v6
-- ============================================================

-- ─── sale_orders: add discount_amount ────────────────────────
-- Stores rabais (negotiated discount) separately from total_amount.
-- total_amount always = catalog total (for inventory / reporting).
-- amount_paid is derived from payments records.
-- discount_amount + amount_paid = total_amount for a closed discounted sale.
ALTER TABLE sale_orders ADD COLUMN IF NOT EXISTS discount_amount numeric NOT NULL DEFAULT 0;

-- ─── payments: remove 'wave' from method constraint ──────────
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check
  CHECK (method IN ('especes', 'orange', 'mtn', 'moov', 'digital'));
