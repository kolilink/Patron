-- ============================================================
-- Patron — Migration v188
-- Run in Supabase SQL Editor AFTER migration_v187
--
-- "Réception intelligente" — Stage 1 (manual draft, no AI yet; the AI
-- extraction step is Stage 2 and needs no schema change of its own, since
-- it only ever produces the same p_lines shape this RPC already accepts).
--
-- confirm_reception() is the one atomic call the "Tout est bon ✓" button
-- makes. It deliberately does NOT reinvent stock/cost logic — it creates
-- or updates a purchase_order + po_lines reflecting what was *actually*
-- received, then calls the existing, already-hardened
-- receive_purchase_order() to do the real work (stock_moves, AVCO cost
-- update, transport-cost allocation, auto transport_achat expense). This
-- is the same "bundle the money with the mutation" pattern submit_sale and
-- create_purchase_order already use, and reusing receive_purchase_order
-- outright (rather than copying its body) means any future fix to that
-- function automatically applies here too.
--
-- Key design decisions, since the product brief's data model was explicit
-- about being indicative, not literal:
--
-- 1. No new "receptions" table. A confirmed réception IS a purchase_order
--    lifecycle event (creation + immediate receipt) — building a parallel
--    entity that duplicates commande semantics is exactly the "two systems
--    drift" shape this codebase has already been burned by once (the two
--    independently-maintained "Nouvelle commande" screens, migration_v167
--    note). The in-progress draft itself is explicitly local-only per the
--    brief ("auto-sauvegardé en local", "supprimé après 7 jours") — it
--    never needs a server row at all.
--
-- 2. purchase_orders.supplier_id and po_lines.product_id are both NOT
--    NULL (base schema) — "Marché" (no real supplier) can't be a
--    null FK, so it resolves to a real, auto-created-once-per-business
--    placeholder supplier row instead. Simpler and lower-risk than
--    loosening a NOT NULL constraint that reconciliation checks and other
--    code may already assume holds.
--
-- 3. "Commande passe en Terminées avec les quantités réelles" (even on an
--    under-delivery — "reçu : 340" against "commandé : 350") is handled by
--    overwriting po_lines.qty_ordered to the real received quantity before
--    calling receive_purchase_order with no explicit line filter — that
--    function's own final-status logic (received_lines = total_lines →
--    'recu') then naturally lands on "Terminée" instead of the
--    'recu_partiel' status it uses for its own, different "receive some
--    now, more later" case. This is a deliberate, narrower semantic for
--    réception specifically: confirming always means the order is closed.
--
-- 4. Margin (sale_price) is applied in the same loop that resolves each
--    line's product, using the client-computed value per line (global %
--    or a per-line override) — trusted the same way submit_sale already
--    trusts client-computed cart amounts elsewhere in this app. Applied
--    before calling receive_purchase_order, but order doesn't actually
--    matter: that function only ever touches cost_price (via AVCO), never
--    sale_price.
--
-- Deliberately out of scope for this pass (flagged, not silently
-- dropped): per-variant sale_price on a réception line (variants only
-- ever need a *quantity* split per the brief — "demander uniquement si le
-- produit existe déjà... avec des variantes" — pricing them individually
-- was never asked for); "modifiable/supprimable depuis son détail" for an
-- already-confirmed réception (a real undo would need to reverse stock
-- moves, AVCO cost, and possibly a created product — non-trivial, and not
-- needed to ship the confirm flow itself); a dedicated reconciliation
-- check (this reuses receive_purchase_order's own money/stock path
-- exactly, so it's already covered by every check that already covers
-- that function).
-- ============================================================

-- Shared by confirm_reception() below and update_reception_supplier()
-- (migration_v189.sql, added when the Confirmé-step supplier chip needed to
-- actually persist post-save) — a real one, or the per-business "Marché"
-- placeholder, found-or-created, never duplicated. Kept as its own function
-- so the two callers can never drift on what "no supplier" resolves to —
-- exactly the class of bug this codebase already got burned by once with
-- two independently-maintained "Nouvelle commande" screens (migration_v167).
--
-- SECURITY: both callers already gate on get_role(p_business_id) before
-- reaching this function, but Postgres grants EXECUTE on a new SECURITY
-- DEFINER function to PUBLIC (which includes anon/authenticated) by default
-- unless explicitly revoked — see CLAUDE.md's "REVOKE EXECUTE ... FROM
-- PUBLIC does not lock a function to service_role" note. Without a check of
-- its own, this function was directly callable by any authenticated (even
-- anonymous-session) caller against an arbitrary p_business_id, letting a
-- non-member write a bogus "Marché" supplier row into someone else's
-- business. Guarded here too, defense-in-depth, so it's safe standalone
-- and not just safe-by-virtue-of-its-current-callers.
CREATE OR REPLACE FUNCTION public.resolve_reception_supplier(
  p_business_id uuid,
  p_supplier_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_supplier_id uuid;
BEGIN
  IF NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF p_supplier_id IS NOT NULL THEN
    RETURN p_supplier_id;
  END IF;
  SELECT id INTO v_supplier_id FROM suppliers
    WHERE business_id = p_business_id AND name = 'Marché';
  IF NOT FOUND THEN
    INSERT INTO suppliers (business_id, name, created_by)
    VALUES (p_business_id, 'Marché', auth.uid())
    RETURNING id INTO v_supplier_id;
  END IF;
  RETURN v_supplier_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.confirm_reception(
  p_business_id          uuid,
  p_supplier_id          uuid    DEFAULT NULL,  -- NULL = "Marché"
  p_po_id                uuid    DEFAULT NULL,  -- Porte 2: existing order being confirmed
  p_lines                jsonb   DEFAULT '[]',
  p_transport_cost_cents bigint  DEFAULT 0,
  p_margin_percent       numeric DEFAULT NULL   -- stored for the future corrections/habits loop (Stage 3); not read here
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_supplier_id uuid;
  v_po_id       uuid;
  v_item        jsonb;
  v_product_id  uuid;
  v_variant_id  uuid;
  v_qty         numeric;
  v_unit_cost   numeric;
  v_total_cost  numeric := 0;
BEGIN
  IF get_role(p_business_id) IS NULL OR get_role(p_business_id) NOT IN ('administrateur', 'manager') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF p_lines IS NULL OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Ajoutez au moins un article' USING ERRCODE = 'P0001';
  END IF;

  -- Resolve the supplier: a real one, or the per-business placeholder for
  -- an unlinked/market purchase. Found-or-created, never duplicated.
  v_supplier_id := resolve_reception_supplier(p_business_id, p_supplier_id);

  -- Resolve or create the purchase order this réception closes.
  IF p_po_id IS NOT NULL THEN
    SELECT id INTO v_po_id FROM purchase_orders
      WHERE id = p_po_id AND business_id = p_business_id AND status NOT IN ('recu', 'annule');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Commande introuvable ou déjà terminée' USING ERRCODE = 'P0001';
    END IF;
    -- The réception's own line list is the real, final record of what was
    -- actually received — not what was originally planned — so it fully
    -- replaces whatever lines the order had before.
    DELETE FROM po_lines WHERE po_id = v_po_id;
  ELSE
    INSERT INTO purchase_orders (business_id, supplier_id, status, created_by)
    VALUES (p_business_id, v_supplier_id, 'brouillon', auth.uid())
    RETURNING id INTO v_po_id;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_product_id := nullif(v_item->>'product_id', '')::uuid;
    v_variant_id := nullif(v_item->>'variant_id', '')::uuid;
    v_qty        := (v_item->>'qty')::numeric;
    v_unit_cost  := (v_item->>'unit_cost_cents')::numeric / 100.0;

    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'Quantité invalide pour "%"', coalesce(v_item->>'name', 'un article') USING ERRCODE = 'P0001';
    END IF;

    IF v_product_id IS NULL THEN
      -- New product — variants are never asked for on a brand-new line
      -- (per the brief, that question only applies to a product that
      -- already has variants at the catalogue), so v_variant_id is always
      -- null here.
      INSERT INTO products (business_id, name, supplier_id, cost_price, sale_price, created_by)
      VALUES (
        p_business_id,
        v_item->>'name',
        v_supplier_id,
        round(v_unit_cost * 100)::bigint,
        coalesce((v_item->>'sale_price_cents')::bigint, 0),
        auth.uid()
      )
      RETURNING id INTO v_product_id;
    ELSIF v_variant_id IS NULL AND nullif(v_item->>'sale_price_cents', '') IS NOT NULL THEN
      -- Existing simple product: apply the confirmed margin price.
      -- cost_price is deliberately left untouched here — AVCO below (via
      -- receive_purchase_order) is the single source of truth for it.
      UPDATE products SET sale_price = (v_item->>'sale_price_cents')::bigint WHERE id = v_product_id;
    END IF;

    INSERT INTO po_lines (po_id, product_id, variant_id, qty_ordered, qty_received, unit_cost)
    VALUES (v_po_id, v_product_id, v_variant_id, v_qty, 0, v_unit_cost);

    v_total_cost := v_total_cost + v_qty * v_unit_cost;
  END LOOP;

  UPDATE purchase_orders SET total_cost = v_total_cost WHERE id = v_po_id;

  -- Stock, AVCO cost, transport allocation + auto expense, and the final
  -- PO status all come from here, unchanged. qty_ordered above already
  -- equals the real received quantity for every line, so receiving
  -- everything ordered (no explicit line filter) always closes the order
  -- as "recu" — this réception's whole point, even on an under-delivery.
  PERFORM receive_purchase_order(v_po_id, p_business_id, NULL, NULL, p_transport_cost_cents);

  RETURN v_po_id;
END;
$$;
