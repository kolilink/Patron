-- ============================================================
-- migration_v244 — conflict closure: a contested decision refuses loudly
--
-- 1. decide_expense (NEW): approve/reject an expense as ONE guarded RPC.
--    The old client path was a blind `UPDATE expenses SET status=…` replayed
--    from the outbox, so the last device to sync silently overwrote whatever
--    another admin had decided meanwhile (or decided an expense that had been
--    deleted). Now, against the CURRENT server state:
--      - soft-deleted           -> P0001 "Cette dépense a été supprimée."
--      - already decided, other outcome -> P0001 naming the decider
--      - already decided, same outcome  -> success, no write (replay-safe)
--      - not en_attente / admin-manager only
--    P0001 is a business rejection, so the drain marks the op permanently
--    failed and it surfaces in RefusedOpsNotice with this exact sentence.
--
-- 2. cancel_sale: NO CHANGE NEEDED. The already-cancelled guard
--    (IF v_sale.status = 'annule' THEN RETURN true) sits BEFORE the
--    stock-return INSERT in the live body (migration_v218, from v125/v215);
--    it returns boolean, which every caller relies on, so the signature is
--    deliberately left alone. Proven by cancel-sale.integration.test.ts
--    (a second cancel adds no second 'annulation' stock entree).
--
-- 3. update_product stays LAST-WRITE-WINS — deliberate. A price/name edit
--    that loses a race costs one re-edit and nothing downstream (sales
--    snapshot unit_price / cost_price_at_sale), so a version check would add
--    refusals for no money-correctness gain.
-- ============================================================

CREATE OR REPLACE FUNCTION public.decide_expense(
  p_expense_id uuid,
  p_status     text            -- 'approuve' | 'rejete'
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_exp     expenses%ROWTYPE;
  v_decider text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Connexion requise.' USING ERRCODE = 'P0001';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('approuve', 'rejete') THEN
    RAISE EXCEPTION 'Décision invalide.' USING ERRCODE = 'P0001';
  END IF;

  -- Base table on purpose: the soft-deleted row must be visible to be refused.
  SELECT * INTO v_exp FROM expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cette dépense est introuvable.' USING ERRCODE = 'P0001';
  END IF;

  IF get_role(v_exp.business_id) IS NULL
     OR get_role(v_exp.business_id) NOT IN ('administrateur', 'manager') THEN
    RAISE EXCEPTION 'Vous ne pouvez pas décider de cette dépense.' USING ERRCODE = 'P0001';
  END IF;

  IF v_exp.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cette dépense a été supprimée.' USING ERRCODE = 'P0001';
  END IF;

  IF v_exp.status <> 'en_attente' THEN
    IF v_exp.status = p_status THEN
      RETURN true;                      -- replay / same outcome: nothing to do
    END IF;
    SELECT COALESCE(m.display_name, pr.name, 'un autre gérant') INTO v_decider
      FROM profiles pr
      LEFT JOIN memberships m ON m.user_id = pr.id AND m.business_id = v_exp.business_id
     WHERE pr.id = v_exp.approved_by
     LIMIT 1;
    RAISE EXCEPTION 'Cette dépense a déjà été % par %.',
      CASE v_exp.status WHEN 'approuve' THEN 'approuvée' WHEN 'rejete' THEN 'rejetée' ELSE 'traitée' END,
      COALESCE(v_decider, 'un autre gérant')
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE expenses
     SET status = p_status, approved_by = auth.uid(), approved_at = now()
   WHERE id = p_expense_id;
  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.decide_expense(uuid, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.decide_expense(uuid, text) TO authenticated;
