-- ============================================================
-- Patron — Migration v230
-- Run in Supabase SQL Editor AFTER migration_v229
--
-- Fix: delete_business() could not delete ANY business that has sales
-- (proven on production 2026-10-05, Phase 8 demo cleanup). It was only ever
-- exercised on empty throwaway businesses (migration_v165). Two independent
-- failures, both surfacing once a business has real child rows:
--
-- 1. 23503 foreign_key_violation from the RESTRICT references to products:
--    so_lines.product_id, stock_moves.product_id and po_lines.product_id are
--    all REFERENCES products(id) with no ON DELETE action. DELETE FROM
--    businesses cascades to products AND (separately) to sale_orders /
--    purchase_orders / stock_moves, but Postgres fires the RESTRICT check on
--    the product delete before the other cascade branch has removed the
--    referencing rows. Fix: delete those referencing rows explicitly first,
--    scoped to exactly p_business_id.
--
-- 2. migration_v210's eight trg_bump_version_* triggers (sale_orders,
--    so_lines, payments, stock_moves, products, product_variants, clients,
--    businesses) fire during the cascade and UPSERT business_data_versions
--    for the business being deleted — whose row is already gone, so the FK
--    from business_data_versions.business_id is violated. (v217 fixed only
--    the AFTER DELETE ON businesses trigger itself; the child-table triggers
--    still hit it.) v165 and v210 were never tested together. Fix: mute the
--    eight triggers for the duration of the delete and re-enable them before
--    returning — on the error path too. bump_business_data_version() is NOT
--    changed: bumping on a child-row delete is correct for sync; only the
--    whole-business delete must be muted.
--
-- 3. (found by this migration's own integration test, not in the original
--    diagnosis) migration_v213's suppliers_guard_delete BEFORE DELETE trigger
--    on suppliers raises P0001 for any supplier that has purchase orders or an
--    unpaid supplier_debt. The businesses -> suppliers cascade deletes the
--    supplier row before the purchase_orders / supplier_debts cascade branch
--    has removed those rows, so any business with a purchase order tripped it.
--    The guard exists to stop a single supplier delete from silently
--    destroying money owed; a whole-business delete intentionally removes all
--    of it. Fix: mute that one trigger in the same window as the bump triggers.
--
-- Superset of v165: the is_founder() gate, the four existing cleanup
-- statements and the final DELETE FROM businesses are unchanged.
--
-- Note on ALTER TABLE ... DISABLE TRIGGER (nine triggers now: the eight bump
-- triggers + suppliers_guard_delete): it takes a SHARE ROW EXCLUSIVE
-- lock on each table for the rest of the transaction (blocking concurrent
-- writes to those tables, not reads). Acceptable for a founder-only cleanup
-- RPC; the DISABLE/ENABLE pair is transactional, so a rollback restores the
-- original trigger state regardless.
-- ============================================================

CREATE OR REPLACE FUNCTION delete_business(p_business_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_founder() THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  -- v165 cleanup (unchanged).
  DELETE FROM notification_log WHERE business_id = p_business_id;
  UPDATE reconciliation_findings SET business_id = NULL WHERE business_id = p_business_id;
  UPDATE businesses SET referred_by_business_id = NULL WHERE referred_by_business_id = p_business_id;
  UPDATE partner_invite_codes SET used_by_business_id = NULL WHERE used_by_business_id = p_business_id;

  -- Mute v210's version-bump triggers and v213's supplier-delete guard for
  -- the whole-business delete (the pre-deletes run inside the window too).
  BEGIN
    ALTER TABLE sale_orders      DISABLE TRIGGER trg_bump_version_sale_orders;
    ALTER TABLE so_lines         DISABLE TRIGGER trg_bump_version_so_lines;
    ALTER TABLE payments         DISABLE TRIGGER trg_bump_version_payments;
    ALTER TABLE stock_moves      DISABLE TRIGGER trg_bump_version_stock_moves;
    ALTER TABLE products         DISABLE TRIGGER trg_bump_version_products;
    ALTER TABLE product_variants DISABLE TRIGGER trg_bump_version_product_variants;
    ALTER TABLE clients          DISABLE TRIGGER trg_bump_version_clients;
    ALTER TABLE businesses       DISABLE TRIGGER trg_bump_version_businesses;
    ALTER TABLE suppliers        DISABLE TRIGGER suppliers_guard_delete;

    -- Pre-delete the rows that RESTRICT-reference products(id), for exactly
    -- this business, so the businesses -> products cascade is not blocked.
    DELETE FROM so_lines
     WHERE order_id IN (SELECT id FROM sale_orders WHERE business_id = p_business_id);
    DELETE FROM stock_moves WHERE business_id = p_business_id;
    DELETE FROM po_lines
     WHERE po_id IN (SELECT id FROM purchase_orders WHERE business_id = p_business_id);

    -- Everything else references businesses(id) ON DELETE CASCADE and cleans
    -- up automatically from here.
    DELETE FROM businesses WHERE id = p_business_id;

    ALTER TABLE sale_orders      ENABLE TRIGGER trg_bump_version_sale_orders;
    ALTER TABLE so_lines         ENABLE TRIGGER trg_bump_version_so_lines;
    ALTER TABLE payments         ENABLE TRIGGER trg_bump_version_payments;
    ALTER TABLE stock_moves      ENABLE TRIGGER trg_bump_version_stock_moves;
    ALTER TABLE products         ENABLE TRIGGER trg_bump_version_products;
    ALTER TABLE product_variants ENABLE TRIGGER trg_bump_version_product_variants;
    ALTER TABLE clients          ENABLE TRIGGER trg_bump_version_clients;
    ALTER TABLE businesses       ENABLE TRIGGER trg_bump_version_businesses;
    ALTER TABLE suppliers        ENABLE TRIGGER suppliers_guard_delete;
  EXCEPTION WHEN OTHERS THEN
    -- The EXCEPTION clause rolls this block's subtransaction back (which
    -- already restores the triggers), but re-enable explicitly as well so the
    -- guarantee does not depend on that implicit behaviour, then re-raise.
    ALTER TABLE sale_orders      ENABLE TRIGGER trg_bump_version_sale_orders;
    ALTER TABLE so_lines         ENABLE TRIGGER trg_bump_version_so_lines;
    ALTER TABLE payments         ENABLE TRIGGER trg_bump_version_payments;
    ALTER TABLE stock_moves      ENABLE TRIGGER trg_bump_version_stock_moves;
    ALTER TABLE products         ENABLE TRIGGER trg_bump_version_products;
    ALTER TABLE product_variants ENABLE TRIGGER trg_bump_version_product_variants;
    ALTER TABLE clients          ENABLE TRIGGER trg_bump_version_clients;
    ALTER TABLE businesses       ENABLE TRIGGER trg_bump_version_businesses;
    ALTER TABLE suppliers        ENABLE TRIGGER suppliers_guard_delete;
    RAISE;
  END;
END;
$$;

REVOKE EXECUTE ON FUNCTION delete_business(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION delete_business(uuid) TO authenticated;
