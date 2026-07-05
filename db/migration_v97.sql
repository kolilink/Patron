-- ============================================================
-- Patron — Migration v97
-- Run in Supabase SQL Editor AFTER migration_v96
--
-- Fix: get_partner_stock — include actual stock_qty in response.
-- The previous version returned only `in_stock: boolean` which
-- was a workaround for a front-end text-rendering issue. The
-- front-end now displays quantities as plain text (no pill /
-- no border-radius) so the clipping issue is gone. We add
-- stock_qty to the returned JSON so the screen can show the
-- actual number.
-- ============================================================

CREATE OR REPLACE FUNCTION get_partner_stock(
  p_partnership_id UUID,
  p_my_business_id UUID
) RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role TEXT; v_requester UUID; v_recipient UUID;
  v_is_requester BOOLEAN; v_they_share BOOLEAN;
  v_partner_biz UUID; v_partner_name TEXT; v_result JSON;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Non autorisé'; END IF;

  SELECT role INTO v_role FROM memberships
  WHERE user_id = auth.uid() AND business_id = p_my_business_id LIMIT 1;
  IF v_role IS NULL OR v_role NOT IN ('administrateur','manager') THEN
    RAISE EXCEPTION 'Non autorisé';
  END IF;

  SELECT bp.requester_id, bp.recipient_id,
    (bp.requester_id = p_my_business_id),
    CASE WHEN bp.requester_id = p_my_business_id
      THEN bp.recipient_shares_stock ELSE bp.requester_shares_stock END
  INTO v_requester, v_recipient, v_is_requester, v_they_share
  FROM business_partnerships bp
  WHERE bp.id = p_partnership_id AND bp.status = 'accepted'
    AND (bp.requester_id = p_my_business_id OR bp.recipient_id = p_my_business_id);

  IF v_requester IS NULL THEN RAISE EXCEPTION 'Partenariat introuvable'; END IF;
  IF NOT v_they_share THEN
    RAISE EXCEPTION 'Ce partenaire a désactivé le partage de stock';
  END IF;

  v_partner_biz := CASE WHEN v_is_requester THEN v_recipient ELSE v_requester END;
  SELECT name INTO v_partner_name FROM businesses WHERE id = v_partner_biz;

  SELECT json_build_object(
    'business_name', v_partner_name,
    'products', (
      SELECT json_agg(json_build_object(
        'name', p.name,
        'category', p.category,
        'stock_qty', p.stock_qty,
        'in_stock', p.stock_qty > 0,
        'unit', p.unit
      ) ORDER BY p.category NULLS LAST, p.name)
      FROM products p
      WHERE p.business_id = v_partner_biz AND p.archived = false AND p.is_system = false
    )
  ) INTO v_result;

  RETURN v_result;
END; $$;
GRANT EXECUTE ON FUNCTION get_partner_stock(UUID, UUID) TO authenticated;
