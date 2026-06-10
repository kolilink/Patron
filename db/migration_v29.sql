-- ============================================================
-- Patron — Migration v29
-- Run in Supabase SQL Editor AFTER migration_v28
-- Enforce business limits at the database level:
--   • A user can create at most 1 business (be admin of 1)
--   • A user can join at most 3 businesses via invite code
-- ============================================================

-- 1. Restrict business creation to 1 per user
--    (only blocks INSERT if the user already owns a business as admin)
DROP POLICY IF EXISTS "Tout le monde: créer un commerce" ON businesses;

CREATE POLICY "Un commerce créé par utilisateur"
  ON businesses FOR INSERT WITH CHECK (
    auth.uid() = created_by
    AND NOT EXISTS (
      SELECT 1 FROM memberships
      WHERE user_id = auth.uid()
        AND role = 'administrateur'
    )
  );

-- 2. Limit joined businesses to 3 per user (non-admin memberships only)
--    Admin memberships (created businesses) are not counted against this limit.
DROP POLICY IF EXISTS "Adhésion propre uniquement" ON memberships;

CREATE POLICY "Adhésion propre uniquement"
  ON memberships FOR INSERT WITH CHECK (
    user_id = auth.uid()
    AND (
      SELECT COUNT(*) FROM memberships
      WHERE user_id = auth.uid()
        AND role != 'administrateur'
    ) < 3
  );
