-- ============================================================
-- Patron — Migration v208
-- Run in Supabase SQL Editor AFTER migration_v207
--
-- "Espaces sociaux" — Phase 6 (pre-launch checklist §7, item 6):
--   * L'équipe Patron — a team account whose welcome post is pinned
--     atop Le Marché. The founder's own profile is the stable account
--     behind it (author_id = get_founder_id()), so the team identity
--     never breaks the "one stable account per post" rule from Phase 5.
--   * market_posts.is_pinned — the founder may pin/unpin any approved
--     post via pin_market_post(). Exactly the moderation affordance the
--     welcome post needs, no more.
--
-- Safe to re-run (ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE / DO
-- guard). Follows migration_v207's idempotent style.
-- ============================================================

-- ─── 1. market_posts.is_pinned ───────────────────────────────
-- Pinned posts sort to the top of Le Marché. One boolean, no queue
-- table: a single welcome post + occasional founder notices is all
-- the spec asks for.

ALTER TABLE market_posts ADD COLUMN IF NOT EXISTS is_pinned boolean
  NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS market_posts_is_pinned
  ON market_posts (is_pinned DESC, created_at DESC);

-- ─── 2. L'équipe Patron — pinned welcome post (idempotent) ────
-- Seeded exactly once: a single pinned welcome post authored by the
-- founder's stable account, displayed as "L'équipe Patron". The guard
-- key is (author_id = founder, is_pinned = true) so re-running never
-- duplicates it. If the founder profile does not exist yet (fresh DB),
-- we skip silently — the app still ships a graceful empty state.

DO $$
DECLARE
  v_founder uuid := get_founder_id();
BEGIN
  IF v_founder IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM market_posts
     WHERE author_id = v_founder AND is_pinned = true
  ) THEN
    INSERT INTO market_posts (
      author_id, author_name, title, content, category, status, is_pinned
    ) VALUES (
      v_founder,
      'L''équipe Patron',
      'Bienvenue sur Le Marché',
      'Le Marché est l''espace commun de la communauté Patron : '
      || 'partagez vos astuces, posez vos questions d''entraide, et '
      || 'proposez vos suggestions pour améliorer l''application. '
      || 'Annonces utiles, échanges entre commerçants — restez bienveillants '
      || 'et respectez le code de conduite affiché en haut de cet espace. '
      || 'Votre pseudo, jamais votre nom légal, vous représente ici.',
      'general',
      'approved',
      true
    );
  END IF;
END $$;

-- ─── 3. pin_market_post — founder-only pin/unpin ─────────────
-- The only moderation write in this phase. Founder pins the welcome
-- post or surfaces an important notice; unpinning returns the feed to
-- pure chronology. Regular members get a clear refusal.

CREATE OR REPLACE FUNCTION public.pin_market_post(
  p_post_id uuid,
  p_pinned  boolean
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_founder() THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM market_posts WHERE id = p_post_id) THEN
    RETURN false;
  END IF;

  UPDATE market_posts SET is_pinned = p_pinned WHERE id = p_post_id;
  RETURN FOUND;
END;
$$;

GRANT EXECUTE ON FUNCTION public.pin_market_post(uuid, boolean) TO authenticated;
