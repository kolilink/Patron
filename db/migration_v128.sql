-- ============================================================
-- Patron — Migration v128
-- Run in Supabase SQL Editor AFTER migration_v127
--
-- Adds a 1-5 star rating on support conversations, prompted to the merchant
-- once the founder marks a thread "Résolu" — feedback loop the founder can
-- use to see how support is landing.
--
-- No new RLS policy needed: rating/rated_at are plain columns on
-- support_conversations, already readable by whoever could already read
-- the row (the owning merchant via merchant_user_id = auth.uid(), or the
-- founder via is_founder() — both from migration_v126/v127).
-- ============================================================

ALTER TABLE support_conversations
  ADD COLUMN IF NOT EXISTS rating   smallint CHECK (rating IS NULL OR (rating BETWEEN 1 AND 5)),
  ADD COLUMN IF NOT EXISTS rated_at timestamptz;

CREATE OR REPLACE FUNCTION submit_support_rating(p_conversation_id uuid, p_rating smallint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
BEGIN
  IF p_rating < 1 OR p_rating > 5 THEN
    RAISE EXCEPTION 'Note invalide' USING ERRCODE = 'P0001';
  END IF;

  SELECT merchant_user_id INTO v_owner FROM support_conversations WHERE id = p_conversation_id;
  IF v_owner IS NULL OR v_owner != auth.uid() THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  UPDATE support_conversations
  SET rating = p_rating, rated_at = now()
  WHERE id = p_conversation_id;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION submit_support_rating(uuid, smallint) TO authenticated;
