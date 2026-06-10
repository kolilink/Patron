-- migration_v39: contribution-gated posting
-- • comment_likes table + trigger (feeds profiles.points, same column as post likes)
-- • toggle_comment_like SECURITY DEFINER RPC
-- • create_market_comment: open to all authenticated members (remove role gate)
-- • create_market_post: replace role gate with 5-points threshold; admins always bypass

-- ─── 1. likes_count on market_comments ───────────────────────────────────────
ALTER TABLE market_comments ADD COLUMN IF NOT EXISTS likes_count INTEGER NOT NULL DEFAULT 0;

-- ─── 2. comment_likes ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS comment_likes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id UUID NOT NULL REFERENCES market_comments(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES profiles(id)        ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (comment_id, user_id)
);
ALTER TABLE comment_likes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Forum: voir les likes de commentaires"
  ON comment_likes FOR SELECT TO authenticated USING (true);

-- ─── 3. handle_comment_like trigger ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION handle_comment_like()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE market_comments
      SET likes_count = likes_count + 1
      WHERE id = NEW.comment_id;
    UPDATE profiles
      SET points = points + 1
      WHERE id = (SELECT author_id FROM market_comments WHERE id = NEW.comment_id);
    RETURN NEW;
  ELSE -- DELETE
    UPDATE market_comments
      SET likes_count = GREATEST(likes_count - 1, 0)
      WHERE id = OLD.comment_id;
    UPDATE profiles
      SET points = GREATEST(points - 1, 0)
      WHERE id = (SELECT author_id FROM market_comments WHERE id = OLD.comment_id);
    RETURN OLD;
  END IF;
END;
$$;

CREATE TRIGGER trg_comment_like
  AFTER INSERT OR DELETE ON comment_likes
  FOR EACH ROW EXECUTE FUNCTION handle_comment_like();

-- ─── 4. toggle_comment_like RPC ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION toggle_comment_like(p_comment_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_uid    UUID    := auth.uid();
  v_exists BOOLEAN;
BEGIN
  -- Prevent self-voting
  IF EXISTS (
    SELECT 1 FROM market_comments WHERE id = p_comment_id AND author_id = v_uid
  ) THEN
    RAISE EXCEPTION 'Auto-upvotes désactivés';
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM comment_likes WHERE comment_id = p_comment_id AND user_id = v_uid
  ) INTO v_exists;

  IF v_exists THEN
    DELETE FROM comment_likes WHERE comment_id = p_comment_id AND user_id = v_uid;
    RETURN FALSE;
  ELSE
    INSERT INTO comment_likes(comment_id, user_id) VALUES (p_comment_id, v_uid);
    RETURN TRUE;
  END IF;
END; $$;
GRANT EXECUTE ON FUNCTION toggle_comment_like(uuid) TO authenticated;

-- ─── 5. create_market_comment: open to all authenticated members ──────────────
CREATE OR REPLACE FUNCTION create_market_comment(
  p_post_id     UUID,
  p_parent_id   UUID,
  p_content     TEXT,
  p_author_name TEXT
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_id  UUID;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Non authentifié'; END IF;

  -- Enforce 1-level nesting: the parent must itself be a top-level comment
  IF p_parent_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM market_comments WHERE id = p_parent_id AND parent_id IS NOT NULL
  ) THEN RAISE EXCEPTION 'Maximum un niveau de réponse autorisé'; END IF;

  INSERT INTO market_comments(post_id, parent_id, author_id, author_name, content)
    VALUES (p_post_id, p_parent_id, v_uid, p_author_name, p_content)
    RETURNING id INTO v_id;

  RETURN v_id;
END; $$;
GRANT EXECUTE ON FUNCTION create_market_comment(uuid, uuid, text, text) TO authenticated;

-- ─── 6. create_market_post: points threshold (admins bypass) ─────────────────
-- profiles.points accumulates from both post likes and comment likes.
-- Threshold: 5 points = unlock posting. Administrateurs always bypass.
CREATE OR REPLACE FUNCTION create_market_post(
  p_title       TEXT,
  p_content     TEXT,
  p_category    TEXT,
  p_author_name TEXT
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_points INTEGER;
  v_id     UUID;
BEGIN
  -- Admins bypass the points threshold
  IF NOT EXISTS (
    SELECT 1 FROM memberships WHERE user_id = v_uid AND role = 'administrateur'
  ) THEN
    SELECT points INTO v_points FROM profiles WHERE id = v_uid;
    IF COALESCE(v_points, 0) < 5 THEN
      RAISE EXCEPTION 'Publiez des réponses et obtenez 5 likes pour débloquer les publications';
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
