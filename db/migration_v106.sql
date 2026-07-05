-- ============================================================
-- Patron — Migration v106
-- Run in Supabase SQL Editor AFTER migration_v105
--
-- Fix: v105 tried to drop the payments INSERT policy by a name
-- copied from db/schema.sql ("Membres actifs: enregistrer les
-- paiements"), but the live policy on production has since been
-- renamed to "Insérer paiement" (DROP POLICY IF EXISTS silently
-- no-op'd on the stale name — confirmed via pg_policies after
-- applying v105). This drops the actual live policy, closing the
-- direct-insert hole v105 intended to close.
--
-- Verified no current code path inserts a payment with a null
-- order_id (the other branch this policy covered) — record_payment
-- and record_client_payment (both SECURITY DEFINER, unaffected by
-- RLS) are the only writers into `payments` after a sale exists.
-- ============================================================

DROP POLICY IF EXISTS "Insérer paiement" ON payments;
