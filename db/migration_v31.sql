-- ============================================================
-- Patron — Migration v31
-- Run in Supabase SQL Editor AFTER migration_v30
-- Enforce max 1 manager per business at the database level.
-- ============================================================

DROP POLICY IF EXISTS "Adhésion propre uniquement" ON memberships;

CREATE POLICY "Adhésion propre uniquement"
  ON memberships FOR INSERT WITH CHECK (
    user_id = auth.uid()
    -- Personal join limit: max 3 non-admin memberships across all businesses
    AND (
      SELECT COUNT(*) FROM memberships
      WHERE user_id = auth.uid()
        AND role != 'administrateur'
    ) < 3
    -- Business manager limit: max 1 manager per business
    AND (
      role != 'manager'
      OR NOT EXISTS (
        SELECT 1 FROM memberships m2
        WHERE m2.business_id = business_id
          AND m2.role = 'manager'
      )
    )
  );
