-- ============================================================
-- Patron — Migration v21
-- Run in Supabase SQL Editor AFTER migration_v20
-- Patches: C-3 (invite_codes RLS), C-4 (memberships UPDATE),
--          M-2 (rate limiting), m-4 (stock_moves audit note),
--          m-6 (expired code cleanup)
-- ============================================================

-- ─── C-3 + M-2: Sécurisation des codes d'invitation ─────────────────────────
-- L'ancienne politique "Lecture codes publique" autorisait tout utilisateur
-- non authentifié à lire la table invite_codes (business_id, role, expires_at…).
-- Fix : seuls les admins/managers peuvent lire leurs codes directement.
-- La validation lors du "rejoindre" passe désormais par une fonction
-- SECURITY DEFINER qui intègre la limitation de débit (5 essais / 10 min).

DROP POLICY IF EXISTS "Lecture codes publique" ON invite_codes;

CREATE POLICY "Admins/Managers: voir les codes d'invitation"
  ON invite_codes FOR SELECT
  USING (get_role(business_id) IN ('administrateur', 'manager'));


-- Table de suivi des tentatives de saisie de code (rate limiting)
CREATE TABLE IF NOT EXISTS invite_attempts (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  attempted_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE invite_attempts ENABLE ROW LEVEL SECURITY;
-- Aucune politique directe : table accessible uniquement via la fonction ci-dessous.


-- Fonction SECURITY DEFINER : validation + incrément atomique + rate limit
CREATE OR REPLACE FUNCTION public.validate_invite_code(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_attempts int;
  v_invite   record;
BEGIN
  -- Vérifier la limite de débit (5 tentatives par 10 minutes par utilisateur)
  SELECT COUNT(*) INTO v_attempts
  FROM invite_attempts
  WHERE user_id = auth.uid()
    AND attempted_at > now() - interval '10 minutes';

  IF v_attempts >= 5 THEN
    RAISE EXCEPTION 'Trop de tentatives. Réessayez dans 10 minutes.' USING ERRCODE = 'P0001';
  END IF;

  -- Enregistrer cette tentative
  INSERT INTO invite_attempts (user_id) VALUES (auth.uid());

  -- Nettoyage des tentatives de plus d'une heure
  DELETE FROM invite_attempts WHERE attempted_at < now() - interval '1 hour';

  -- Rechercher le code (insensible à la casse, vérifie expiration et quota)
  SELECT id, business_id, role, expires_at, max_uses, uses
  INTO v_invite
  FROM invite_codes
  WHERE code = upper(trim(p_code))
    AND (expires_at IS NULL OR expires_at > now())
    AND (max_uses IS NULL OR uses < max_uses)
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Incrément atomique du compteur d'utilisations
  UPDATE invite_codes SET uses = uses + 1 WHERE id = v_invite.id;

  RETURN jsonb_build_object(
    'business_id', v_invite.business_id,
    'role',        v_invite.role
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.validate_invite_code(text) TO authenticated;


-- ─── C-4: Politique UPDATE sur memberships ────────────────────────────────────
-- Sans cette politique, equipe.changeRole() était silencieusement bloqué par
-- RLS. Les gérants pensaient changer un rôle alors que rien ne changeait en base.

DROP POLICY IF EXISTS "Admins/Managers: modifier les rôles" ON memberships;

CREATE POLICY "Admins/Managers: modifier les rôles"
  ON memberships FOR UPDATE
  USING  (get_role(business_id) IN ('administrateur', 'manager'))
  WITH CHECK (get_role(business_id) IN ('administrateur', 'manager'));


-- ─── m-4: Intentional immutability of stock_moves ────────────────────────────
-- AUCUNE politique DELETE n'est définie sur stock_moves.
-- C'est intentionnel : la piste d'audit des mouvements de stock est immuable.
-- Ne PAS ajouter de politique DELETE — cela permettrait une manipulation
-- rétroactive de l'inventaire sans laisser de trace.


-- ─── m-6: Nettoyage automatique des codes expirés (pg_cron) ─────────────────
-- Nécessite l'extension pg_cron activée dans votre projet Supabase
-- (Database → Extensions → pg_cron). Décommentez après activation.
--
-- SELECT cron.schedule(
--   'cleanup-expired-invite-codes',
--   '0 3 * * *',
--   $$ DELETE FROM invite_codes WHERE expires_at < now() - interval '7 days'; $$
-- );
