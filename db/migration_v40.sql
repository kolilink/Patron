-- migration_v40: community_level on profiles
-- • calculate_merchant_level() function — 9-tier step ladder
-- • BEFORE UPDATE trigger keeps community_level in sync whenever points changes
-- • Backfill existing profiles
-- • create_market_post: gate on community_level < 2 (replacing raw points check)
-- • toggle_comment_like + toggle_post_like: pair velocity cap (3 likes/day per unique pair)

-- ─── 1. community_level column ────────────────────────────────────────────────
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS community_level INTEGER NOT NULL DEFAULT 1;

-- ─── 2. Level calculation function ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION calculate_merchant_level(p_points INTEGER)
RETURNS INTEGER LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p_points >= 27000 THEN RETURN 9; END IF;
  IF p_points >= 8100  THEN RETURN 8; END IF;
  IF p_points >= 2400  THEN RETURN 7; END IF;
  IF p_points >= 730   THEN RETURN 6; END IF;
  IF p_points >= 220   THEN RETURN 5; END IF;
  IF p_points >= 65    THEN RETURN 4; END IF;
  IF p_points >= 20    THEN RETURN 3; END IF;
  IF p_points >= 5     THEN RETURN 2; END IF;
  RETURN 1;
END; $$;

-- ─── 3. Trigger: sync community_level before any points update ────────────────
CREATE OR REPLACE FUNCTION sync_community_level()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.community_level := calculate_merchant_level(NEW.points);
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_sync_community_level ON profiles;
CREATE TRIGGER trg_sync_community_level
  BEFORE UPDATE OF points ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION sync_community_level();

-- ─── 4. Backfill existing profiles ───────────────────────────────────────────
UPDATE profiles SET community_level = calculate_merchant_level(COALESCE(points, 0));

-- ─── 5. create_market_post: gate on community_level >= 2 ─────────────────────
CREATE OR REPLACE FUNCTION create_market_post(
  p_title       TEXT,
  p_content     TEXT,
  p_category    TEXT,
  p_author_name TEXT
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_uid   UUID := auth.uid();
  v_level INTEGER;
  v_id    UUID;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Non authentifié'; END IF;

  -- Admins bypass; everyone else needs community_level >= 2 (5 points)
  IF NOT EXISTS (
    SELECT 1 FROM memberships WHERE user_id = v_uid AND role = 'administrateur'
  ) THEN
    SELECT community_level INTO v_level FROM profiles WHERE id = v_uid;
    IF COALESCE(v_level, 1) < 2 THEN
      RAISE EXCEPTION 'Participez aux discussions et obtenez 5 likes pour débloquer la publication';
    END IF;
  END IF;

  IF p_category NOT IN ('suggestion', 'entraide', 'general')
    THEN RAISE EXCEPTION 'Catégorie invalide'; END IF;

  INSERT INTO market_posts(author_id, author_name, title, content, category)
    VALUES (v_uid, p_author_name, p_title, p_content, p_category)
    RETURNING id INTO v_id;

  RETURN v_id;
END; $$;
GRANT EXECUTE ON FUNCTION create_market_post(text, text, text, text) TO authenticated;

-- ─── 6. toggle_comment_like: add pair velocity cap ────────────────────────────
-- Max 3 likes per unique user-pair per 24 hours (across posts + comments).
-- Toggling OFF is always allowed regardless of the cap.
CREATE OR REPLACE FUNCTION toggle_comment_like(p_comment_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_uid        UUID    := auth.uid();
  v_author     UUID;
  v_exists     BOOLEAN;
  v_pair_count INTEGER;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Non authentifié'; END IF;

  SELECT author_id INTO v_author FROM market_comments WHERE id = p_comment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Commentaire introuvable'; END IF;

  -- Self-like prevention
  IF v_author = v_uid THEN RAISE EXCEPTION 'Auto-upvotes désactivés'; END IF;

  SELECT EXISTS(
    SELECT 1 FROM comment_likes WHERE comment_id = p_comment_id AND user_id = v_uid
  ) INTO v_exists;

  IF v_exists THEN
    -- Toggling off — always allowed
    DELETE FROM comment_likes WHERE comment_id = p_comment_id AND user_id = v_uid;
    RETURN FALSE;
  ELSE
    -- Pair velocity cap: max 3 likes from v_uid → v_author in last 24 h
    SELECT COUNT(*) INTO v_pair_count
    FROM (
      SELECT cl.id
      FROM comment_likes cl
      JOIN market_comments mc ON mc.id = cl.comment_id
      WHERE cl.user_id = v_uid
        AND mc.author_id = v_author
        AND cl.created_at > now() - INTERVAL '24 hours'
      UNION ALL
      SELECT pl.id
      FROM post_likes pl
      JOIN market_posts mp ON mp.id = pl.post_id
      WHERE pl.user_id = v_uid
        AND mp.author_id = v_author
        AND pl.created_at > now() - INTERVAL '24 hours'
    ) pair_interactions;

    IF v_pair_count >= 3 THEN
      RAISE EXCEPTION 'Limite quotidienne atteinte pour cet auteur';
    END IF;

    INSERT INTO comment_likes(comment_id, user_id) VALUES (p_comment_id, v_uid);
    RETURN TRUE;
  END IF;
END; $$;
GRANT EXECUTE ON FUNCTION toggle_comment_like(uuid) TO authenticated;

-- ─── 7. toggle_post_like: same pair velocity cap ──────────────────────────────
CREATE OR REPLACE FUNCTION toggle_post_like(p_post_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_uid        UUID    := auth.uid();
  v_author     UUID;
  v_exists     BOOLEAN;
  v_pair_count INTEGER;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Non authentifié'; END IF;

  SELECT author_id INTO v_author FROM market_posts WHERE id = p_post_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Post introuvable'; END IF;

  -- Self-like prevention
  IF v_author = v_uid THEN RAISE EXCEPTION 'Vous ne pouvez pas aimer votre propre post'; END IF;

  SELECT EXISTS(
    SELECT 1 FROM post_likes WHERE post_id = p_post_id AND user_id = v_uid
  ) INTO v_exists;

  IF v_exists THEN
    -- Toggling off — always allowed
    DELETE FROM post_likes WHERE post_id = p_post_id AND user_id = v_uid;
    RETURN FALSE;
  ELSE
    -- Pair velocity cap: max 3 likes from v_uid → v_author in last 24 h
    SELECT COUNT(*) INTO v_pair_count
    FROM (
      SELECT cl.id
      FROM comment_likes cl
      JOIN market_comments mc ON mc.id = cl.comment_id
      WHERE cl.user_id = v_uid
        AND mc.author_id = v_author
        AND cl.created_at > now() - INTERVAL '24 hours'
      UNION ALL
      SELECT pl.id
      FROM post_likes pl
      JOIN market_posts mp ON mp.id = pl.post_id
      WHERE pl.user_id = v_uid
        AND mp.author_id = v_author
        AND pl.created_at > now() - INTERVAL '24 hours'
    ) pair_interactions;

    IF v_pair_count >= 3 THEN
      RAISE EXCEPTION 'Limite quotidienne atteinte pour cet auteur';
    END IF;

    INSERT INTO post_likes(post_id, user_id) VALUES (p_post_id, v_uid);
    RETURN TRUE;
  END IF;
END; $$;
GRANT EXECUTE ON FUNCTION toggle_post_like(uuid) TO authenticated;
