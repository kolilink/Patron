-- ============================================================
-- Patron — Migration v20
-- Run in Supabase SQL Editor AFTER migration_v19
-- ============================================================

-- ─── Fix: drop the v12 catch-all policy that overrides the v19 isolation ─────
-- migration_v12 renamed the policy from "Membres non-investisseurs: voir les
-- ventes" to "Membres: voir les ventes" (is_member only, no role check).
-- migration_v19 dropped the OLD name, which no longer existed, so the v12
-- policy survived and allowed all members to see all sales.
-- Drop it now — the two role-specific policies from v19 already replace it.

DROP POLICY IF EXISTS "Membres: voir les ventes" ON sale_orders;
