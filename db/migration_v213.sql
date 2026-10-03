-- ============================================================
-- Patron — Migration v213
-- Run in Supabase SQL Editor AFTER migration_v212
-- ============================================================
-- P0-2: supplier delete destroys money.
--
-- Problem:
--   supplier_debts.supplier_id and supplier_payments.supplier_id are
--   ON DELETE CASCADE, so deleting a supplier that still has an
--   unpaid debt silently erased the money the business is owed, plus
--   the whole payment history. Deleting a supplier with purchase
--   orders instead surfaced a raw foreign-key violation, which the
--   client flattened into a generic "impossible" message.
--
-- Fix:
--   A BEFORE DELETE trigger on suppliers that raises distinct,
--   truthful French messages:
--     1. an unpaid debt (amount > amount_paid) blocks deletion —
--        the money consequence is named;
--     2. any purchase order blocks deletion — the exact blocker is
--        named (supprimez / réassignez les commandes d'abord).
--   The trigger is SECURITY DEFINER (set search_path = public) so it
--   can read supplier_debts / purchase_orders without RLS recursion.

DROP TRIGGER IF EXISTS suppliers_guard_delete ON suppliers;
DROP FUNCTION IF EXISTS suppliers_prevent_money_destroy();

CREATE OR REPLACE FUNCTION suppliers_prevent_money_destroy()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM supplier_debts
    WHERE supplier_id = OLD.id
      AND amount > amount_paid
  ) THEN
    RAISE EXCEPTION
      'Ce fournisseur a une dette impayée. Le supprimer effacerait cet argent dû. Remboursez cette dette avant de supprimer le fournisseur.'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM purchase_orders
    WHERE supplier_id = OLD.id
  ) THEN
    RAISE EXCEPTION
      'Ce fournisseur est lié à des commandes fournisseur. Supprimez ou réassignez ces commandes avant de supprimer le fournisseur.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN OLD;
END;
$$;

CREATE TRIGGER suppliers_guard_delete
  BEFORE DELETE ON suppliers
  FOR EACH ROW
  EXECUTE FUNCTION suppliers_prevent_money_destroy();
