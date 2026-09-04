-- migration_v168: Transaction proof images become deletable, within a
-- narrow, explicit window — reversing part of migration_v155's original
-- "add once, never delete, ever" design on direct product request.
--
-- migration_v155 tracked no "who attached it / when" at all — attach was
-- meant to be permanent, so there was nothing to check a delete against.
-- Enforcing "only the uploader, only within 24h" requires that identity and
-- timestamp to actually exist, so this adds proof_attached_by/proof_attached_at
-- alongside the existing proof_image_* trio on all three tables, and stamps
-- them from attach_transaction_proof (CREATE OR REPLACE is safe here — same
-- parameter count/signature as before, see migration_v132's note on why that
-- only matters when the count changes).
--
-- delete_transaction_proof(kind, id) is the only way to clear a proof:
--   · caller must be the exact person who attached it (proof_attached_by =
--     auth.uid()) — not admin/manager in general, not the record's own
--     created_by, specifically whoever ran the attach call;
--   · only within 24 hours of proof_attached_at, checked against the
--     server clock (auth.uid() and now() are both server-resolved, same
--     posture as edit_sale's 48h window) — never the device's own clock.
-- Nulls the three proof_image_* columns plus proof_attached_by/_at. Does
-- NOT delete the underlying storage object — transaction-proofs still has
-- no DELETE policy (migration_v155), so the blob is orphaned rather than
-- removed. That's deliberate, not an oversight: reaching into Storage from
-- a SECURITY DEFINER SQL function isn't a plain DELETE the way clearing a
-- row's columns is, and an orphaned blob costs storage, not correctness —
-- nothing renders it once the DB columns are null. Revisit only if orphan
-- volume ever actually matters.

-- ─── 1. Columns ───────────────────────────────────────────────────────────────

ALTER TABLE capital_injections
  ADD COLUMN IF NOT EXISTS proof_attached_by uuid REFERENCES profiles(id),
  ADD COLUMN IF NOT EXISTS proof_attached_at timestamptz;

ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS proof_attached_by uuid REFERENCES profiles(id),
  ADD COLUMN IF NOT EXISTS proof_attached_at timestamptz;

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS proof_attached_by uuid REFERENCES profiles(id),
  ADD COLUMN IF NOT EXISTS proof_attached_at timestamptz;

-- ─── 2. attach_transaction_proof — now also stamps who/when ───────────────────

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

  -- get_role() returns NULL for a caller who isn't a member of v_business_id
  -- at all (not just the wrong role) — and `NULL NOT IN (...)` / `NULL IN (...)`
  -- evaluate to NULL, which plpgsql's IF treats as false, silently skipping
  -- the exception below. Explicit NULL guard so a non-member is blocked
  -- outright instead of falling through the role check unauthenticated-against-
  -- this-business. See db/migration_v173.sql for the same class of fix applied
  -- to every other RPC that had this exact gap.
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

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

  IF v_existing IS NOT NULL THEN
    RAISE EXCEPTION 'Une preuve est déjà attachée' USING ERRCODE = 'P0001';
  END IF;

  IF p_kind = 'apport' THEN
    UPDATE capital_injections
      SET proof_image_url    = p_image_url,
          proof_image_width  = p_image_width,
          proof_image_height = p_image_height,
          proof_attached_by  = auth.uid(),
          proof_attached_at  = now()
      WHERE id = p_id;
  ELSIF p_kind = 'expense' THEN
    UPDATE expenses
      SET proof_image_url    = p_image_url,
          proof_image_width  = p_image_width,
          proof_image_height = p_image_height,
          proof_attached_by  = auth.uid(),
          proof_attached_at  = now()
      WHERE id = p_id;
  ELSIF p_kind = 'purchase_order' THEN
    UPDATE purchase_orders
      SET proof_image_url    = p_image_url,
          proof_image_width  = p_image_width,
          proof_image_height = p_image_height,
          proof_attached_by  = auth.uid(),
          proof_attached_at  = now()
      WHERE id = p_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.attach_transaction_proof(text, uuid, text, int, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.attach_transaction_proof(text, uuid, text, int, int) TO authenticated;

-- ─── 3. delete_transaction_proof ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.delete_transaction_proof(
  p_kind text,
  p_id   uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business_id   uuid;
  v_attached_by   uuid;
  v_attached_at   timestamptz;
  v_existing      text;
BEGIN
  IF p_kind = 'apport' THEN
    SELECT business_id, proof_image_url, proof_attached_by, proof_attached_at
      INTO v_business_id, v_existing, v_attached_by, v_attached_at
      FROM capital_injections WHERE id = p_id;
  ELSIF p_kind = 'expense' THEN
    SELECT business_id, proof_image_url, proof_attached_by, proof_attached_at
      INTO v_business_id, v_existing, v_attached_by, v_attached_at
      FROM expenses WHERE id = p_id;
  ELSIF p_kind = 'purchase_order' THEN
    SELECT business_id, proof_image_url, proof_attached_by, proof_attached_at
      INTO v_business_id, v_existing, v_attached_by, v_attached_at
      FROM purchase_orders WHERE id = p_id;
  ELSE
    RAISE EXCEPTION 'Type de preuve inconnu' USING ERRCODE = 'P0001';
  END IF;

  IF v_business_id IS NULL OR v_existing IS NULL THEN
    RAISE EXCEPTION 'Aucune image à supprimer' USING ERRCODE = 'P0001';
  END IF;

  -- Deliberately narrower than attach's role gate: not admin/manager in
  -- general, specifically whoever ran the attach call — matches the exact
  -- rule requested ("only the person that added it can delete it").
  IF v_attached_by IS NULL OR v_attached_by != auth.uid() THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF v_attached_at IS NULL OR now() - v_attached_at > interval '24 hours' THEN
    RAISE EXCEPTION 'Le délai de 24 heures pour supprimer cette image est dépassé' USING ERRCODE = 'P0001';
  END IF;

  IF p_kind = 'apport' THEN
    UPDATE capital_injections
      SET proof_image_url = NULL, proof_image_width = NULL, proof_image_height = NULL,
          proof_attached_by = NULL, proof_attached_at = NULL
      WHERE id = p_id;
  ELSIF p_kind = 'expense' THEN
    UPDATE expenses
      SET proof_image_url = NULL, proof_image_width = NULL, proof_image_height = NULL,
          proof_attached_by = NULL, proof_attached_at = NULL
      WHERE id = p_id;
  ELSIF p_kind = 'purchase_order' THEN
    UPDATE purchase_orders
      SET proof_image_url = NULL, proof_image_width = NULL, proof_image_height = NULL,
          proof_attached_by = NULL, proof_attached_at = NULL
      WHERE id = p_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_transaction_proof(text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.delete_transaction_proof(text, uuid) TO authenticated;
