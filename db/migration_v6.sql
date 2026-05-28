-- ============================================================
-- Patron — Migration v6
-- Run in Supabase SQL Editor AFTER migration_v5
-- ============================================================

-- ─── sale_orders: add is_credit flag ─────────────────────────
ALTER TABLE sale_orders ADD COLUMN IF NOT EXISTS is_credit boolean NOT NULL DEFAULT false;

-- Backfill: any existing sale with status='credit' was made on credit
UPDATE sale_orders SET is_credit = true WHERE status = 'credit';

-- ─── payments: delete fake "credit" payment records ──────────
-- These were inserted at checkout to represent "client owes" but
-- caused amount_paid to show full total, making Reste = 0.
DELETE FROM payments WHERE method = 'credit';

-- ─── payments: tighten method constraint ─────────────────────
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check
  CHECK (method IN ('especes', 'wave', 'orange', 'mtn', 'moov', 'digital'));

-- ─── sale_orders: no status changes needed ───────────────────
-- Status stays 'credit' for unpaid/partial credit sales.
-- The app derives the display state (crédit vs partiel) from amount_paid.
