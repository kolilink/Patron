-- ============================================================
-- Patron — Migration v217
-- Run in Supabase SQL Editor AFTER migration_v216
-- ============================================================
-- E2E FIX BATCH C — team & membership. TEST DB only — do not commit.
--
-- Five fixes, three of which are server-side (this file) and two of which
-- are client-side (parametres/index.tsx + stores/products.ts + vendre.tsx):
--
--   (1) vendeur/investisseur cannot leave          → client: route handleLeave
--       through leave_or_delete_business instead of the RLS-blocked
--       memberships DELETE (the v215 DELETE policy only admits
--       administrateur/manager, so a vendeur/investisseur's own
--       memberships.delete() was silently rejected). leave_or_delete_business
--       is SECURITY DEFINER and already handles every role, so no server
--       change is required for (1) — the function below is only touched for
--       fix (4).
--   (2) product-scope toggle lies with zero products → submit_sale below.
--       migration_v80 had the correct enforcement keyed on the
--       `scope_all_products` flag (false + no assigned rows = blocked).
--       migration_v215 REGRESSED this to only check `v_has_scope` (rows
--       exist), so a vendeur with scope_all_products=false and ZERO assigned
--       products could still sell every product in the shop. This file
--       restores v80's exact semantics.
--   (3) second manager via direct UPDATE              → the
--       memberships_prevent_role_escalation trigger below. join_business
--       enforces one-manager-per-shop on the join path, but a direct
--       memberships.update({role:'manager'}) bypassed it entirely.
--   (4) sole-member "Quitter" crashes on real data    → leave_or_delete_business
--       below. A sole admin's DELETE FROM businesses relied on cascade for
--       everything, but four FKs don't cascade (notification_log.business_id
--       is NOT NULL, plus three nullable refs), so it FK-violated on any
--       business that had real activity. The same four-step cleanup
--       delete_business (migration_v165) already does is applied first.
--   (5) leave/delete dream flows + never-surface-raw-error + leaving never
--       deletes sales/payments/ledger                  → client only (see
--       parametres/index.tsx). rpcErrorMessage already only surfaces P0001
--       French RAISE text verbatim, and the non-admin branch of
--       leave_or_delete_business deletes ONLY the membership row — sales,
--       payments and ledger all belong to the business and stay untouched.

-- ──────────────────────────────────────────────────────────────
-- Fix (4): leave_or_delete_business must clean up the four
-- non-cascading business_id references before deleting the business.
-- ──────────────────────────────────────────────────────────────
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
  -- Every RAISE EXCEPTION here is real, French, user-facing copy, not an
  -- internal code — the client shows a bare RAISE's message verbatim
  -- whenever its SQLSTATE is P0001 (the default for a plain RAISE EXCEPTION,
  -- same as every other exception below), so an English/placeholder string
  -- here would leak to the screen exactly like a raw infrastructure error.
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Session invalide. Reconnectez-vous.';
  END IF;

  v_role := get_role(p_business_id);
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Vous n''êtes pas membre de ce commerce.';
  END IF;

  IF v_role <> 'administrateur' THEN
    -- Leaving is NOT deleting: only this membership row is removed. Every
    -- sale, payment and ledger entry belongs to the business and stays.
    DELETE FROM memberships WHERE business_id = p_business_id AND user_id = v_user_id;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM memberships
    WHERE business_id = p_business_id AND user_id <> v_user_id
  ) THEN
    SELECT name INTO v_name FROM businesses WHERE id = p_business_id;
    RAISE EXCEPTION '% a d''autres membres actifs. Retirez-les avant de le quitter.', COALESCE(v_name, 'Ce commerce')
      USING ERRCODE = 'P0001';
  END IF;

  -- Fix (4): the same four non-cascading references delete_business
  -- (migration_v165) cleans up first. Without these, a sole admin's leave
  -- FK-violates on any business with real activity (notification_log.business_id
  -- is NOT NULL and has no cascade; the other three are nullable but leave
  -- dangling references). Everything else references businesses(id)
  -- ON DELETE CASCADE and cleans up automatically from here.
  DELETE FROM notification_log WHERE business_id = p_business_id;
  UPDATE reconciliation_findings SET business_id = NULL WHERE business_id = p_business_id;
  UPDATE businesses SET referred_by_business_id = NULL WHERE referred_by_business_id = p_business_id;
  UPDATE partner_invite_codes SET used_by_business_id = NULL WHERE used_by_business_id = p_business_id;

  DELETE FROM businesses WHERE id = p_business_id;
END;
$$;

REVOKE ALL ON FUNCTION leave_or_delete_business(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION leave_or_delete_business(uuid) TO authenticated;

-- ──────────────────────────────────────────────────────────────
-- Fix (4) continued: migration_v210's trg_bump_version_businesses fires
-- AFTER DELETE ON businesses and re-inserts a business_data_versions row
-- referencing the just-deleted business — an instant FK violation on EVERY
-- business deletion (leave or delete), with or without real activity.
-- Bumping a data-version for a row that no longer exists is pointless, so
-- skip it when the businesses table itself is being deleted from.
-- ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bump_business_data_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bid uuid;
BEGIN
  -- Fix (4): a deleted business no longer exists, so re-inserting a
  -- business_data_versions row for it FK-violates. Other tables' DELETEs
  -- (sale_orders, payments, stock_moves, products, …) still bump the version
  -- of their still-existing business and are unaffected.
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'businesses' THEN
    RETURN OLD;
  END IF;

  v_bid := NULL;

  IF TG_TABLE_NAME IN ('sale_orders', 'stock_moves', 'products', 'product_variants', 'clients') THEN
    v_bid := COALESCE(NEW.business_id, OLD.business_id);
  ELSIF TG_TABLE_NAME = 'payments' THEN
    v_bid := COALESCE(NEW.business_id, OLD.business_id);
    IF v_bid IS NULL THEN
      SELECT business_id INTO v_bid
      FROM sale_orders
      WHERE id = COALESCE(NEW.order_id, OLD.order_id);
    END IF;
  ELSIF TG_TABLE_NAME = 'so_lines' THEN
    SELECT business_id INTO v_bid
    FROM sale_orders
    WHERE id = COALESCE(NEW.order_id, OLD.order_id);
  ELSIF TG_TABLE_NAME = 'businesses' THEN
    v_bid := COALESCE(NEW.id, OLD.id);
  END IF;

  IF v_bid IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  INSERT INTO business_data_versions (business_id, version, updated_at)
  VALUES (v_bid, 1, now())
  ON CONFLICT (business_id)
  DO UPDATE SET version = business_data_versions.version + 1, updated_at = now();

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- ──────────────────────────────────────────────────────────────
-- Fix (2): restore v80's scope_all_products-keyed enforcement in
-- submit_sale. A vendeur with scope_all_products=false and zero assigned
-- products must be blocked, not unrestricted.
-- ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.submit_sale(
  p_business_id      uuid,
  p_seller_id        uuid,
  p_customer_name    text      DEFAULT NULL,
  p_sale_date        date      DEFAULT CURRENT_DATE,
  p_total_amount     numeric   DEFAULT 0,
  p_discount_amount  numeric   DEFAULT 0,
  p_is_credit        boolean   DEFAULT false,
  p_cart             jsonb     DEFAULT '[]',
  p_pay_method       text      DEFAULT NULL,
  p_pay_amount       numeric   DEFAULT NULL,
  p_pay_ref          text      DEFAULT NULL,
  p_idempotency_key  uuid      DEFAULT NULL,
  p_client_id        uuid      DEFAULT NULL,
  p_due_date         date      DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order_id       uuid;
  v_item           jsonb;
  v_membership_id  uuid;
  v_scope_all      boolean;
  v_has_scope      boolean;
  v_cost_price     bigint;
  v_unit_price_eff bigint;
  v_line_profit    bigint;
  v_investor       RECORD;
  v_rows_affected  integer;
  v_computed_total bigint;
BEGIN
  IF get_role(p_business_id) IS NULL OR get_role(p_business_id) NOT IN ('administrateur', 'manager', 'vendeur') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF get_role(p_business_id) = 'vendeur' AND p_seller_id != auth.uid() THEN
    RAISE EXCEPTION 'Un vendeur ne peut enregistrer que ses propres ventes' USING ERRCODE = 'P0001';
  END IF;

  -- Fix (2): vendeur product scope, keyed on the scope_all_products flag
  -- (migration_v80's original logic). scope_all_products=false + no assigned
  -- rows = the vendeur can sell NOTHING, not everything.
  IF get_role(p_business_id) = 'vendeur' THEN
    SELECT id, scope_all_products INTO v_membership_id, v_scope_all
    FROM memberships
    WHERE user_id = auth.uid() AND business_id = p_business_id;

    IF NOT v_scope_all THEN
      SELECT EXISTS(
        SELECT 1 FROM membership_product_scope WHERE membership_id = v_membership_id
      ) INTO v_has_scope;

      IF NOT v_has_scope THEN
        RAISE EXCEPTION 'Vous n''avez pas encore de produits assignés. Contactez votre gérant.' USING ERRCODE = 'P0001';
      END IF;

      PERFORM 1
      FROM jsonb_to_recordset(p_cart) AS c(product_id uuid)
      WHERE c.product_id NOT IN (
        SELECT product_id FROM membership_product_scope
        WHERE membership_id = v_membership_id
      );
      IF FOUND THEN
        RAISE EXCEPTION 'Produit non autorisé : vous ne pouvez pas vendre ce produit' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_order_id
    FROM sale_orders
    WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN RETURN v_order_id; END IF;
  END IF;

  -- Validate the whole cart BEFORE inserting anything — fail fast, nothing
  -- to roll back. Every qty must be a real positive number, and every
  -- product/variant must actually belong to this business (SECURITY
  -- DEFINER means RLS never enforces this on its own — see migration note).
  IF p_cart IS NULL OR jsonb_array_length(p_cart) = 0 THEN
    RAISE EXCEPTION 'Ajoutez au moins un article' USING ERRCODE = 'P0001';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_cart) LOOP
    IF (v_item->>'qty')::numeric IS NULL OR (v_item->>'qty')::numeric <= 0 THEN
      RAISE EXCEPTION 'Quantité invalide pour "%"', coalesce(v_item->>'product_name', 'un article')
        USING ERRCODE = 'P0001';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM products
      WHERE id = (v_item->>'product_id')::uuid AND business_id = p_business_id
    ) THEN
      RAISE EXCEPTION 'Produit introuvable' USING ERRCODE = 'P0001';
    END IF;

    IF nullif(v_item->>'variant_id', '') IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM product_variants
      WHERE id = nullif(v_item->>'variant_id', '')::uuid AND business_id = p_business_id
    ) THEN
      RAISE EXCEPTION 'Produit introuvable' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  v_order_id := gen_random_uuid();

  -- Never trust the client's own total: derive it from the same cart it
  -- also supplies, before that cart's lines are even inserted. Line-level
  -- unit_price stays fully trusted (negotiated pricing is intentional) —
  -- only the AGGREGATE total is no longer a separately-asserted number.
  SELECT COALESCE(SUM((item->>'qty')::numeric * (item->>'unit_price')::numeric), 0)::bigint
  INTO v_computed_total
  FROM jsonb_array_elements(p_cart) AS item;

  -- discount guard, mirroring edit_sale's semantics. A negative discount is
  -- nonsense; a discount ≥ total would store a negative-owed debt shown as
  -- «Réglé ✓».
  IF COALESCE(p_discount_amount, 0) < 0 THEN
    RAISE EXCEPTION 'La remise ne peut pas être négative' USING ERRCODE = 'P0001';
  END IF;
  IF COALESCE(p_discount_amount, 0) > 0 AND COALESCE(p_discount_amount, 0) >= v_computed_total THEN
    RAISE EXCEPTION 'La remise doit être inférieure au total' USING ERRCODE = 'P0001';
  END IF;

  -- overpay guard. Never let a payment exceed the remaining balance owed
  -- (total − discount).
  IF p_pay_amount IS NOT NULL
     AND p_pay_amount > (v_computed_total - COALESCE(p_discount_amount, 0)) THEN
    RAISE EXCEPTION 'Le montant dépasse le solde restant dû' USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    INSERT INTO sale_orders (
      id, business_id, seller_id, customer_name, client_id,
      status, is_credit, paid_at, sale_date, due_date,
      total_amount, discount_amount, created_by, idempotency_key
    ) VALUES (
      v_order_id, p_business_id, p_seller_id,
      nullif(trim(coalesce(p_customer_name, '')), ''),
      p_client_id,
      CASE WHEN p_is_credit THEN 'credit' ELSE 'paye' END,
      p_is_credit,
      CASE WHEN NOT p_is_credit THEN now() ELSE NULL END,
      p_sale_date,
      CASE WHEN p_is_credit THEN p_due_date ELSE NULL END,
      v_computed_total, p_discount_amount,
      auth.uid(), p_idempotency_key
    );
  EXCEPTION WHEN unique_violation THEN
    -- Race: another concurrent request with the same key committed first.
    -- Return its order ID so the client gets an idempotent response instead
    -- of a raw duplicate-key error.
    IF p_idempotency_key IS NOT NULL THEN
      SELECT id INTO v_order_id
      FROM sale_orders
      WHERE idempotency_key = p_idempotency_key;
      IF FOUND THEN RETURN v_order_id; END IF;
    END IF;
    RAISE;
  END;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_cart) LOOP
    -- Cost snapshot: variant first, fall back to parent product. business_id
    -- filter is defense-in-depth — the validation pass above already
    -- guarantees ownership.
    v_cost_price := NULL;
    IF nullif(v_item->>'variant_id', '') IS NOT NULL THEN
      SELECT cost_price INTO v_cost_price
      FROM product_variants
      WHERE id = nullif(v_item->>'variant_id', '')::uuid AND business_id = p_business_id;
    END IF;
    IF v_cost_price IS NULL THEN
      SELECT cost_price INTO v_cost_price
      FROM products
      WHERE id = (v_item->>'product_id')::uuid AND business_id = p_business_id;
    END IF;

    INSERT INTO so_lines (
      id, order_id, product_id, product_name,
      qty, unit_price, is_bulk,
      variant_id, variant_name,
      cost_price_at_sale
    ) VALUES (
      gen_random_uuid(), v_order_id,
      (v_item->>'product_id')::uuid,
      v_item->>'product_name',
      (v_item->>'qty')::numeric,
      (v_item->>'unit_price')::numeric,
      coalesce((v_item->>'is_bulk')::boolean, false),
      nullif(v_item->>'variant_id', '')::uuid,
      nullif(v_item->>'variant_name', ''),
      v_cost_price
    );
  END LOOP;

  IF p_pay_method IS NOT NULL AND p_pay_amount IS NOT NULL AND p_pay_amount > 0 THEN
    INSERT INTO payments (id, order_id, customer_name, business_id, method, amount, date, ref_external, seller_id)
    VALUES (
      gen_random_uuid(), v_order_id,
      nullif(trim(coalesce(p_customer_name, '')), ''),
      p_business_id, p_pay_method, p_pay_amount, p_sale_date,
      nullif(trim(coalesce(p_pay_ref, '')), ''),
      auth.uid()
    );
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_cart) LOOP
    INSERT INTO stock_moves (
      id, business_id, product_id, type, qty, ref_id, ref_type, note, created_by
    ) VALUES (
      gen_random_uuid(), p_business_id,
      (v_item->>'product_id')::uuid,
      'sortie',
      (v_item->>'qty')::numeric,
      v_order_id, 'sale_order', NULL, auth.uid()
    );

    IF nullif(v_item->>'variant_id', '') IS NOT NULL THEN
      UPDATE products
      SET stock_qty = GREATEST(0, stock_qty - (v_item->>'qty')::numeric)
      WHERE id = (v_item->>'product_id')::uuid AND business_id = p_business_id;

      UPDATE product_variants
      SET stock_qty = stock_qty - (v_item->>'qty')::numeric
      WHERE id     = nullif(v_item->>'variant_id', '')::uuid
        AND business_id = p_business_id
        AND stock_qty >= (v_item->>'qty')::numeric;

      GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
      IF v_rows_affected = 0 THEN
        RAISE EXCEPTION 'Stock insuffisant : %',
          coalesce(nullif(v_item->>'variant_name', ''), v_item->>'product_name', 'Produit inconnu')
          USING ERRCODE = 'P0001';
      END IF;
    ELSE
      UPDATE products
      SET stock_qty = stock_qty - (v_item->>'qty')::numeric
      WHERE id      = (v_item->>'product_id')::uuid
        AND business_id = p_business_id
        AND stock_qty >= (v_item->>'qty')::numeric;

      GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
      IF v_rows_affected = 0 THEN
        RAISE EXCEPTION 'Stock insuffisant : %',
          coalesce(v_item->>'product_name', 'Produit inconnu')
          USING ERRCODE = 'P0001';
      END IF;
    END IF;

    -- Investor profit accumulation.
    v_cost_price := NULL;
    IF nullif(v_item->>'variant_id', '') IS NOT NULL THEN
      SELECT cost_price INTO v_cost_price
      FROM product_variants
      WHERE id = nullif(v_item->>'variant_id', '')::uuid AND business_id = p_business_id;
    END IF;
    IF v_cost_price IS NULL THEN
      SELECT cost_price INTO v_cost_price
      FROM products
      WHERE id = (v_item->>'product_id')::uuid AND business_id = p_business_id;
    END IF;

    v_unit_price_eff := (v_item->>'unit_price')::bigint;

    v_line_profit := GREATEST(0,
      (v_unit_price_eff - coalesce(v_cost_price, 0))
      * (v_item->>'qty')::bigint
    );

    IF v_line_profit > 0 THEN
      FOR v_investor IN
        SELECT m.user_id, mps.profit_share
        FROM membership_product_scope mps
        JOIN memberships m ON m.id = mps.membership_id
        WHERE mps.product_id  = (v_item->>'product_id')::uuid
          AND m.business_id   = p_business_id
          AND m.role          = 'investisseur'
          AND mps.profit_share > 0
      LOOP
        INSERT INTO investor_balance (business_id, investor_id, balance, updated_at)
        VALUES (
          p_business_id,
          v_investor.user_id,
          ROUND(v_line_profit * v_investor.profit_share / 100.0)::bigint,
          now()
        )
        ON CONFLICT (business_id, investor_id) DO UPDATE
          SET balance    = investor_balance.balance
                         + ROUND(v_line_profit * v_investor.profit_share / 100.0)::bigint,
              updated_at = now();
      END LOOP;
    END IF;
  END LOOP;

  RETURN v_order_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_sale(uuid, uuid, text, date, numeric, numeric, boolean, jsonb, text, numeric, text, uuid, uuid, date) TO authenticated;

-- ──────────────────────────────────────────────────────────────
-- Fix (3): max-one-manager guard on the direct memberships UPDATE path.
-- Extends the migration_v212 trigger (role-escalation + last-admin) with a
-- third branch: promoting any member to 'manager' is refused when another
-- manager already exists, matching join_business's invite-time check.
-- ──────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS memberships_role_guard ON memberships;
DROP FUNCTION IF EXISTS memberships_prevent_role_escalation();

CREATE OR REPLACE FUNCTION memberships_prevent_role_escalation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only an administrateur may change a member's role.
  IF get_role(OLD.business_id) IS DISTINCT FROM 'administrateur' THEN
    RAISE EXCEPTION
      'Seul un administrateur peut modifier les rôles'
      USING ERRCODE = 'P0001';
  END IF;

  -- The last administrateur cannot be demoted.
  IF OLD.role = 'administrateur'
     AND NEW.role IS DISTINCT FROM 'administrateur'
     AND count_business_admins(OLD.business_id) <= 1 THEN
    RAISE EXCEPTION
      'Impossible de rétrograder le dernier administrateur'
      USING ERRCODE = 'P0001';
  END IF;

  -- Fix (3): one manager per business, enforced on the direct UPDATE path
  -- exactly like join_business does on the join path. Only applies when a
  -- member is actually being PROMOTED to manager (OLD.role ≠ manager), so a
  -- no-op save on the existing manager's own row still passes.
  IF NEW.role = 'manager' AND OLD.role IS DISTINCT FROM 'manager' THEN
    IF EXISTS (
      SELECT 1 FROM memberships
      WHERE business_id = OLD.business_id
        AND role = 'manager'
        AND id <> OLD.id
    ) THEN
      RAISE EXCEPTION
        'Cette boutique a déjà un gérant'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER memberships_role_guard
  BEFORE UPDATE OF role ON memberships
  FOR EACH ROW
  EXECUTE FUNCTION memberships_prevent_role_escalation();
