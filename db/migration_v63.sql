-- migration v63: track who cancelled a sale
--
-- Adds cancelled_by_id to sale_orders and updates cancel_sale to capture auth.uid().
-- The frontend always resolves the current profile name at display time, so a
-- member who gets a name after cancelling will automatically show the correct name.

ALTER TABLE sale_orders ADD COLUMN IF NOT EXISTS cancelled_by_id uuid REFERENCES profiles(id);

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

  SELECT id, seller_id INTO v_sale
  FROM sale_orders
  WHERE id = p_sale_id AND business_id = p_business_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vente introuvable' USING ERRCODE = 'P0001';
  END IF;

  IF get_role(p_business_id) = 'vendeur' AND v_sale.seller_id != auth.uid() THEN
    RAISE EXCEPTION 'Un vendeur ne peut annuler que ses propres ventes' USING ERRCODE = 'P0001';
  END IF;

  UPDATE sale_orders
  SET status              = 'annule',
      cancelled_at        = now(),
      cancellation_reason = p_reason,
      cancelled_by_id     = auth.uid()
  WHERE id = p_sale_id;

  -- Restauration du stock (best-effort)
  BEGIN
    FOR v_line IN SELECT product_id, qty FROM so_lines WHERE order_id = p_sale_id LOOP
      INSERT INTO stock_moves (
        id, business_id, product_id, type, qty, ref_id, ref_type, note, created_by
      ) VALUES (
        gen_random_uuid(), p_business_id, v_line.product_id,
        'entree', v_line.qty, p_sale_id, 'annulation',
        'Annulation: ' || coalesce(p_reason, ''), auth.uid()
      );

      UPDATE products
      SET stock_qty = stock_qty + v_line.qty
      WHERE id = v_line.product_id;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_sale(uuid, uuid, text) TO authenticated;
