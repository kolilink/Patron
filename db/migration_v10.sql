-- ============================================================
-- Patron — Migration v10
-- Run in Supabase SQL Editor AFTER migration_v9
-- ============================================================

-- One phone number per account.
-- NULL values are excluded from UNIQUE in PostgreSQL, so unverified
-- (NULL phone) profiles are unaffected.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_phone_unique'
  ) THEN
    ALTER TABLE profiles ADD CONSTRAINT profiles_phone_unique UNIQUE (phone);
  END IF;
END $$;
