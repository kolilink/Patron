-- ============================================================
-- Patron — Migration v30
-- Run in Supabase SQL Editor AFTER migration_v29
-- Fix: vendeurs can only INSERT expenses with status 'en_attente'.
--
-- Previously the INSERT policy had no status constraint, so a
-- vendeur calling the API directly could create an expense with
-- status='approuve', bypassing the approval workflow entirely.
-- ============================================================

DROP POLICY IF EXISTS "Membres: créer des dépenses" ON expenses;

CREATE POLICY "Membres: créer des dépenses"
  ON expenses FOR INSERT WITH CHECK (
    get_role(business_id) IN ('administrateur', 'manager', 'vendeur')
    AND created_by = auth.uid()
    AND (
      get_role(business_id) IN ('administrateur', 'manager')
      OR status = 'en_attente'
    )
  );
