-- ============================================================
-- Patron — Migration v3
-- Run in Supabase SQL Editor AFTER migration_v2
-- ============================================================

-- ─── Add due_date and note to expenses ───────────────────────────────────────
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS due_date date;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS note      text;

-- ─── Allow creators to edit their own pending expenses ───────────────────────
DROP POLICY IF EXISTS "Créateurs: modifier leurs propres dépenses" ON expenses;
CREATE POLICY "Créateurs: modifier leurs propres dépenses" ON expenses
  FOR UPDATE USING (created_by = auth.uid() AND status = 'en_attente')
  WITH CHECK (status = 'en_attente');
