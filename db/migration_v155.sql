-- ============================================================
-- Patron — Migration v155
-- Run in Supabase SQL Editor AFTER migration_v154
--
-- Photo proof ("preuve") for money-movement records: capital
-- injections/withdrawals, expenses, and purchase orders. One
-- optional image per row, attached AFTER the row already exists
-- (never through any creation RPC/insert) — so the same one path
-- serves both a brand-new record and a months-old one added
-- retroactively.
--
--   1. proof_image_url / _width / _height (all nullable) added to
--      capital_injections, expenses, purchase_orders. Nullable and
--      read by none of the 78 reconciliation checks → additive/safe.
--   2. transaction-proofs storage bucket — dedicated, NOT the
--      chat message-images bucket, so receipts never mix into the
--      chat-image namespace (matters if chat images are ever
--      moderated/pruned). Same open "any authenticated user" RLS as
--      message-images; real access is gated at the transaction-row
--      level by each table's existing SELECT RLS. No DELETE policy —
--      proofs are immutable (see below), so nothing ever deletes one.
--   3. attach_transaction_proof(kind, id, url, w, h) — one
--      SECURITY DEFINER RPC for all three tables. Enforces:
--        · role gate per kind (admin/manager for apport & PO;
--          admin/manager OR the expense's own creator while it is
--          still en_attente, for an expense — the vendeur who holds
--          the receipt);
--        · immutability — refuses if a proof is already set, so a
--          photo can be added once but never swapped or wiped
--          ("we cannot delete it, we go back and add it").
--
-- Deliberately NOT wired through record_injection / record_withdrawal
-- / edit_injection / the expenses insert / createCommande — those
-- stay untouched. Expenses can be created offline (SQLite sync_queue)
-- and images can't ride that queue; approved expenses have no edit
-- path at all. A post-hoc attach reaches every one of those cases
-- that threading through creation never could.
-- ============================================================

-- ─── 1. Columns ───────────────────────────────────────────────────────────────

ALTER TABLE capital_injections
  ADD COLUMN IF NOT EXISTS proof_image_url    text,
  ADD COLUMN IF NOT EXISTS proof_image_width  int,
  ADD COLUMN IF NOT EXISTS proof_image_height int;

ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS proof_image_url    text,
  ADD COLUMN IF NOT EXISTS proof_image_width  int,
  ADD COLUMN IF NOT EXISTS proof_image_height int;

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS proof_image_url    text,
  ADD COLUMN IF NOT EXISTS proof_image_width  int,
  ADD COLUMN IF NOT EXISTS proof_image_height int;

-- ─── 2. Storage bucket ────────────────────────────────────────────────────────
-- Path convention: {kind}/{business_id}/{transaction_id}.jpg

INSERT INTO storage.buckets (id, name, public)
VALUES ('transaction-proofs', 'transaction-proofs', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "transaction proofs upload" ON storage.objects;
CREATE POLICY "transaction proofs upload"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'transaction-proofs' AND auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "transaction proofs read" ON storage.objects;
CREATE POLICY "transaction proofs read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'transaction-proofs' AND auth.uid() IS NOT NULL);

-- ─── 3. attach_transaction_proof ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.attach_transaction_proof(
  p_kind          text,
  p_id            uuid,
  p_image_url     text,
  p_image_width   int DEFAULT NULL,
  p_image_height  int DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business_id uuid;
  v_created_by  uuid;
  v_status      text;
  v_existing    text;
  v_role        text;
BEGIN
  IF p_image_url IS NULL OR length(trim(p_image_url)) = 0 THEN
    RAISE EXCEPTION 'Image manquante' USING ERRCODE = 'P0001';
  END IF;

  -- Resolve the target row's business + (for expenses) creator/status,
  -- and its current proof slot, per kind.
  IF p_kind = 'apport' THEN
    SELECT business_id, proof_image_url
      INTO v_business_id, v_existing
      FROM capital_injections WHERE id = p_id;
  ELSIF p_kind = 'expense' THEN
    SELECT business_id, created_by, status, proof_image_url
      INTO v_business_id, v_created_by, v_status, v_existing
      FROM expenses WHERE id = p_id;
  ELSIF p_kind = 'purchase_order' THEN
    SELECT business_id, proof_image_url
      INTO v_business_id, v_existing
      FROM purchase_orders WHERE id = p_id;
  ELSE
    RAISE EXCEPTION 'Type de preuve inconnu' USING ERRCODE = 'P0001';
  END IF;

  IF v_business_id IS NULL THEN
    RAISE EXCEPTION 'Enregistrement introuvable' USING ERRCODE = 'P0001';
  END IF;

  v_role := get_role(v_business_id);

  -- Authorization: apport/PO are admin/manager only; an expense may
  -- also be proven by its own creator while still pending (the vendeur
  -- who actually has the receipt).
  IF p_kind = 'expense' THEN
    IF NOT (v_role IN ('administrateur', 'manager')
            OR (v_created_by = auth.uid() AND v_status = 'en_attente')) THEN
      RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    IF v_role NOT IN ('administrateur', 'manager') THEN
      RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Immutability: add once, never replace or delete.
  IF v_existing IS NOT NULL THEN
    RAISE EXCEPTION 'Une preuve est déjà attachée' USING ERRCODE = 'P0001';
  END IF;

  IF p_kind = 'apport' THEN
    UPDATE capital_injections
      SET proof_image_url    = p_image_url,
          proof_image_width  = p_image_width,
          proof_image_height = p_image_height
      WHERE id = p_id;
  ELSIF p_kind = 'expense' THEN
    UPDATE expenses
      SET proof_image_url    = p_image_url,
          proof_image_width  = p_image_width,
          proof_image_height = p_image_height
      WHERE id = p_id;
  ELSIF p_kind = 'purchase_order' THEN
    UPDATE purchase_orders
      SET proof_image_url    = p_image_url,
          proof_image_width  = p_image_width,
          proof_image_height = p_image_height
      WHERE id = p_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.attach_transaction_proof(text, uuid, text, int, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.attach_transaction_proof(text, uuid, text, int, int) TO authenticated;
