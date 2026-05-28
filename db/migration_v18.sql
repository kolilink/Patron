-- ============================================================
-- Patron — Migration v18
-- Run in Supabase SQL Editor AFTER migration_v17
-- ============================================================

-- ─── Fix 1: invite_codes missing DELETE policy ────────────────────────────────
-- Managers could not revoke codes — the DELETE was silently blocked by RLS.
DROP POLICY IF EXISTS "Admins/Managers: supprimer des codes" ON invite_codes;

CREATE POLICY "Admins/Managers: supprimer des codes"
  ON invite_codes FOR DELETE
  USING (get_role(business_id) IN ('administrateur', 'manager'));


-- ─── Fix 2: expenses missing due_date and note columns ───────────────────────
-- migration_v3 adds these via ALTER TABLE. If v3 was skipped, the expenses
-- INSERT fails with "undefined column". This makes it idempotent.
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS due_date date;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS note     text;
