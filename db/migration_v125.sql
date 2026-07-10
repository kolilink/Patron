-- ============================================================
-- Patron — Migration v125
-- Run in Supabase SQL Editor AFTER migration_v124
--
-- Fix: cancel_sale's stock-restore loop adds the cancelled qty back onto
-- the PARENT product's stock_qty for every line, variant or not.
-- submit_sale's own comment is explicit about the invariant this breaks:
-- "Variant product: guard is on product_variants (parent products.stock_qty
-- is always 0 for variant parents so no meaningful guard there)." Every
-- variant sale that gets cancelled drifts the parent's stock_qty further
-- away from 0 — confirmed via a real integration test against a local
-- Supabase instance: __tests__/integration/cancel-sale.integration.test.ts.
--
-- Fix: only restore the parent's stock_qty when the line has no
-- variant_id. No other behavior change — variant stock restoration is
-- untouched.
-- ============================================================

CREATE OR REPLACE FUNCTION public.cancel_sale(
  p_sale_id     uuid,
  p_business_id uuid,
  p_reason      text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sale record;
  v_line record;
BEGIN
  IF get_role(p_business_id) NOT IN ('administrateur', 'manager', 'vendeur') THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  SELECT id, seller_id, status INTO v_sale
  FROM sale_orders
  WHERE id = p_sale_id AND business_id = p_business_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vente introuvable' USING ERRCODE = 'P0001';
  END IF;

  -- Idempotent: already cancelled — return without touching anything again.
  IF v_sale.status = 'annule' THEN
    RETURN true;
  END IF;

  IF get_role(p_business_id) = 'vendeur' AND v_sale.seller_id != auth.uid() THEN
    RAISE EXCEPTION 'Un vendeur ne peut annuler que ses propres ventes' USING ERRCODE = 'P0001';
  END IF;

  -- Mark the sale as cancelled.
  UPDATE sale_orders
  SET status              = 'annule',
      cancelled_at        = now(),
      cancellation_reason = p_reason,
      cancelled_by_id     = auth.uid()
  WHERE id = p_sale_id;

  -- Delete payments created by submit_sale for this order.
  DELETE FROM payments WHERE order_id = p_sale_id;

  -- Restore stock for every line item.
  BEGIN
    FOR v_line IN
      SELECT product_id, variant_id, qty
      FROM so_lines
      WHERE order_id = p_sale_id
    LOOP
      INSERT INTO stock_moves (
        id, business_id, product_id, type, qty, ref_id, ref_type, note, created_by
      ) VALUES (
        gen_random_uuid(), p_business_id, v_line.product_id,
        'entree', v_line.qty, p_sale_id, 'annulation',
        'Annulation: ' || coalesce(p_reason, ''), auth.uid()
      );

      IF v_line.variant_id IS NOT NULL THEN
        -- Variant product: parent products.stock_qty is always 0 for
        -- variant parents (see submit_sale) — only the variant row moves.
        UPDATE product_variants
        SET stock_qty = stock_qty + v_line.qty
        WHERE id = v_line.variant_id;
      ELSE
        UPDATE products
        SET stock_qty = stock_qty + v_line.qty
        WHERE id = v_line.product_id;
      END IF;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    NULL; -- stock restore is best-effort; cancellation itself is committed
  END;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_sale(uuid, uuid, text) TO authenticated;
