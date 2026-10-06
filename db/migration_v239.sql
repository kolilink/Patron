-- ============================================================
-- Patron — Migration v239
-- Run in Supabase SQL Editor AFTER migration_v238
--
-- DELETE & LEAVE FLOWS, made correct end to end.
--
-- Problems proven on 2026-10-06:
--  1. leave_or_delete_business() (v217) never got v230's hardening, so a
--     sole admin whose business has any real activity fails with
--     "données liées" (RESTRICT/NO ACTION references to products, the v210
--     version-bump triggers, v213's supplier-delete guard).
--  2. An admin with team members was hard-blocked ("retirez-les avant de
--     quitter") — the leaver had to destroy other people's access to exit.
--  3. finalize_account_deletion() (the day-30 cron hard delete) has the same
--     bare `DELETE FROM businesses` as (1) AND ends with
--     `DELETE FROM auth.users`, which 35 NO ACTION foreign keys
--     (device_tokens.user_id, sale_orders.seller_id, ...created_by, ...) make
--     impossible for anyone who ever registered a push token or recorded a
--     sale. Production proof: one account due 2026-10-04 survived two cron
--     runs.
--
-- What this migration does (a SUPERSET: nothing from v165/v177/v178/v212/
-- v217/v223/v230 is dropped):
--
--  A. _purge_business(uuid)  — ONE internal routine that deletes a whole
--     business, used by leave_or_delete_business AND finalize_account_deletion
--     so the delete mechanics can never drift between the two again.
--       * v165/v217/v223 cleanup: notification_log (NOT NULL, NO ACTION),
--         reconciliation_findings, businesses.referred_by_business_id,
--         partner_invite_codes.used_by_business_id.
--       * v230: mute the 8 trg_bump_version_* triggers and
--         suppliers_guard_delete for the delete window (re-enabled on the
--         error path too); pre-delete so_lines / stock_moves / po_lines.
--       * NEW, found by enumerating every FK in the cascade tree (45 tables)
--         instead of from memory: products.supplier_id and
--         purchase_orders.supplier_id are NO ACTION references to suppliers —
--         whether the businesses -> suppliers cascade branch runs before or
--         after products / purchase_orders is not guaranteed, so both are
--         resolved explicitly (supplier_id nulled; purchase_orders deleted,
--         their children cascade). analytics_events.business_id is SET NULL
--         (automatic). No trigger newer than v230 sits on the cascade path
--         (checked against pg_trigger).
--  B. leave_or_delete_business() — the leave matrix:
--       non-admin                                  -> delete own membership
--       admin, others present, ANOTHER admin exists -> delete own membership
--       admin, others present, last admin           -> RAISE P0001 (succession)
--       sole admin, nobody else                     -> _purge_business
--     invalid session / non-member raise exactly as before.
--  C. delete_my_account() — only a SOLE admin with other members is blocked
--     (succession first); an admin who has a co-admin may schedule.
--  D. finalize_account_deletion() — same re-check; purges only solely-owned
--     businesses via _purge_business; deletes push tokens; then tries the real
--     DELETE of profile + auth user, and when other businesses' ledgers still
--     reference the person (sales, expenses, ... they authored) it scrubs the
--     identity in place instead (name, phone, email, sessions, login banned)
--     rather than stranding the request forever.
--
-- Promote-then-leave is legal under v212's last-admin guard: that guard is a
-- BEFORE UPDATE OF role trigger (it stops a role being CHANGED away from the
-- last admin). Promoting B to administrateur is an UPDATE on B's row with
-- OLD.role <> 'administrateur', so it is untouched, and A leaving is a DELETE
-- of A's row, which the guard never sees. Proven in the integration test.
-- ============================================================

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS anonymized_at timestamptz;

-- ─── A. The one place a whole business is deleted ─────────────

CREATE OR REPLACE FUNCTION _purge_business(p_business_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Internal only: no auth check here on purpose — every caller has already
  -- decided the caller may do this (leave_or_delete_business: sole admin;
  -- finalize_account_deletion: service role). Execute is revoked from every
  -- API role below.

  -- v165 / v217 / v223 cleanup: the non-cascading business_id references.
  DELETE FROM notification_log WHERE business_id = p_business_id;
  UPDATE reconciliation_findings SET business_id = NULL WHERE business_id = p_business_id;
  UPDATE businesses SET referred_by_business_id = NULL WHERE referred_by_business_id = p_business_id;
  UPDATE partner_invite_codes SET used_by_business_id = NULL WHERE used_by_business_id = p_business_id;

  BEGIN
    -- v230: mute v210's version-bump triggers and v213's supplier guard for
    -- the whole-business delete (DISABLE TRIGGER takes SHARE ROW EXCLUSIVE:
    -- concurrent writes to those tables wait for this transaction).
    ALTER TABLE sale_orders      DISABLE TRIGGER trg_bump_version_sale_orders;
    ALTER TABLE so_lines         DISABLE TRIGGER trg_bump_version_so_lines;
    ALTER TABLE payments         DISABLE TRIGGER trg_bump_version_payments;
    ALTER TABLE stock_moves      DISABLE TRIGGER trg_bump_version_stock_moves;
    ALTER TABLE products         DISABLE TRIGGER trg_bump_version_products;
    ALTER TABLE product_variants DISABLE TRIGGER trg_bump_version_product_variants;
    ALTER TABLE clients          DISABLE TRIGGER trg_bump_version_clients;
    ALTER TABLE businesses       DISABLE TRIGGER trg_bump_version_businesses;
    ALTER TABLE suppliers        DISABLE TRIGGER suppliers_guard_delete;

    -- v230: rows that NO ACTION-reference products / variants.
    DELETE FROM so_lines
     WHERE order_id IN (SELECT id FROM sale_orders WHERE business_id = p_business_id);
    DELETE FROM stock_moves WHERE business_id = p_business_id;
    DELETE FROM po_lines
     WHERE po_id IN (SELECT id FROM purchase_orders WHERE business_id = p_business_id);

    -- v239: the two NO ACTION references to suppliers. Cascade order between
    -- sibling branches (suppliers vs products / purchase_orders) is not
    -- guaranteed, so resolve them here instead of relying on it.
    UPDATE products SET supplier_id = NULL WHERE business_id = p_business_id AND supplier_id IS NOT NULL;
    DELETE FROM purchase_orders WHERE business_id = p_business_id;

    -- Everything else references businesses(id) ON DELETE CASCADE (or SET
    -- NULL, for analytics_events) and cleans up automatically from here.
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
    -- The EXCEPTION clause already rolls this block's subtransaction back
    -- (restoring the triggers); re-enable explicitly as well so the guarantee
    -- does not depend on that implicit behaviour, then re-raise.
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

REVOKE ALL ON FUNCTION _purge_business(uuid) FROM PUBLIC, anon, authenticated;

-- ─── B. leave_or_delete_business — the leave matrix ───────────

CREATE OR REPLACE FUNCTION leave_or_delete_business(p_business_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_role    text;
  v_name    text;
BEGIN
  -- Every RAISE EXCEPTION here is real, French, user-facing copy (the client
  -- shows a bare RAISE's message verbatim when its SQLSTATE is P0001).
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Session invalide. Reconnectez-vous.';
  END IF;

  v_role := get_role(p_business_id);
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Vous n''êtes pas membre de ce commerce.';
  END IF;

  IF v_role <> 'administrateur' THEN
    -- Leaving is NOT deleting: only this membership row goes. Every sale,
    -- payment and ledger entry belongs to the business and stays.
    DELETE FROM memberships WHERE business_id = p_business_id AND user_id = v_user_id;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM memberships
    WHERE business_id = p_business_id AND user_id <> v_user_id
  ) THEN
    -- Someone else is in this business. An admin may walk away only if the
    -- business keeps an administrateur.
    IF EXISTS (
      SELECT 1 FROM memberships
      WHERE business_id = p_business_id AND user_id <> v_user_id AND role = 'administrateur'
    ) THEN
      DELETE FROM memberships WHERE business_id = p_business_id AND user_id = v_user_id;
      RETURN;
    END IF;

    SELECT name INTO v_name FROM businesses WHERE id = p_business_id;
    RAISE EXCEPTION 'Vous êtes le seul gérant de %. Désignez un successeur avant de quitter.', COALESCE(v_name, 'ce commerce')
      USING ERRCODE = 'P0001';
  END IF;

  -- Sole admin, nobody else: quitting IS deleting.
  PERFORM _purge_business(p_business_id);
END;
$$;

REVOKE ALL ON FUNCTION leave_or_delete_business(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION leave_or_delete_business(uuid) TO authenticated;

-- ─── C. delete_my_account — only a SOLE admin with a team is blocked ──

CREATE OR REPLACE FUNCTION delete_my_account()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_names   text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Session invalide. Reconnectez-vous.';
  END IF;

  -- Named explicitly so the person knows which business to sort out first.
  SELECT string_agg(b.name, ', ')
    INTO v_names
    FROM memberships m1
    JOIN businesses  b ON b.id = m1.business_id
    WHERE m1.user_id = v_user_id
    AND   m1.role    = 'administrateur'
    AND   EXISTS (SELECT 1 FROM memberships m2
                  WHERE m2.business_id = m1.business_id AND m2.user_id <> v_user_id)
    AND   NOT EXISTS (SELECT 1 FROM memberships m3
                      WHERE m3.business_id = m1.business_id AND m3.user_id <> v_user_id
                      AND   m3.role = 'administrateur');

  IF v_names IS NOT NULL THEN
    RAISE EXCEPTION 'Vous êtes le seul gérant de : %. Désignez un successeur avant de supprimer votre compte.', v_names
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE profiles
    SET pending_deletion_at = now() + interval '30 days'
    WHERE id = v_user_id;
END;
$$;

REVOKE ALL ON FUNCTION delete_my_account() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION delete_my_account() TO authenticated;

-- ─── D. finalize_account_deletion — the day-30 hard delete ────

CREATE OR REPLACE FUNCTION finalize_account_deletion(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business_id uuid;
  v_due         timestamptz;
BEGIN
  SELECT pending_deletion_at INTO v_due FROM profiles WHERE id = p_user_id;

  IF v_due IS NULL OR v_due > now() THEN
    RETURN; -- not (or no longer) due — cancelled, or called too early
  END IF;

  IF EXISTS (
    SELECT 1
    FROM   memberships m1
    WHERE  m1.user_id = p_user_id
    AND    m1.role    = 'administrateur'
    AND    EXISTS (SELECT 1 FROM memberships m2
                   WHERE m2.business_id = m1.business_id AND m2.user_id <> p_user_id)
    AND    NOT EXISTS (SELECT 1 FROM memberships m3
                       WHERE m3.business_id = m1.business_id AND m3.user_id <> p_user_id
                       AND   m3.role = 'administrateur')
  ) THEN
    -- Since the request was scheduled, a business this person solely
    -- administers gained a team (or its other admin left). Don't delete an
    -- admin out from under an active team: clear the stale request instead of
    -- raising, so it can't block the rest of the day's batch.
    UPDATE profiles SET pending_deletion_at = NULL WHERE id = p_user_id;
    RETURN;
  END IF;

  -- Only businesses this person owns ALONE are deleted; any other business
  -- simply loses this member (the memberships delete below).
  FOR v_business_id IN
    SELECT m.business_id
    FROM   memberships m
    WHERE  m.user_id = p_user_id
    AND    m.role    = 'administrateur'
    AND    NOT EXISTS (SELECT 1 FROM memberships m2
                       WHERE m2.business_id = m.business_id AND m2.user_id <> p_user_id)
  LOOP
    PERFORM _purge_business(v_business_id);
  END LOOP;

  -- Personal rows that would block removing the login (device_tokens.user_id
  -- is NO ACTION: every account that ever registered for push hit this).
  DELETE FROM device_tokens WHERE user_id = p_user_id;
  DELETE FROM memberships   WHERE user_id = p_user_id;

  BEGIN
    DELETE FROM profiles   WHERE id = p_user_id;
    DELETE FROM auth.users WHERE id = p_user_id;
  EXCEPTION WHEN foreign_key_violation THEN
    -- The person authored rows inside businesses that live on (sales,
    -- expenses, stock moves, ...) and those ledgers keep pointing at their
    -- id. Removing the login is what matters: scrub the identity in place so
    -- nothing personal or usable remains, and the daily job stops retrying.
    UPDATE profiles
       SET name = 'Compte supprimé',
           email = 'deleted-' || p_user_id::text || '@invalid.local',
           phone = NULL, avatar_url = NULL, recovery_email = NULL, pseudo = NULL,
           pending_deletion_at = NULL, anonymized_at = now()
     WHERE id = p_user_id;
    DELETE FROM auth.identities WHERE user_id = p_user_id;
    DELETE FROM auth.sessions   WHERE user_id = p_user_id;
    UPDATE auth.users
       SET email = NULL, phone = NULL, raw_user_meta_data = '{}'::jsonb,
           banned_until = 'infinity'::timestamptz
     WHERE id = p_user_id;
  END;
END;
$$;

REVOKE ALL ON FUNCTION finalize_account_deletion(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION finalize_account_deletion(uuid) TO service_role;
