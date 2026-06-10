-- migration_v37: Le Marché community forum
-- Tables: market_posts, market_comments, post_likes
-- Adds profiles.points column for reputation tracking
-- RPCs: create_market_post, create_market_comment, toggle_post_like (with self-vote guard)

-- ─── profiles.points ─────────────────────────────────────────────────────────
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS points INTEGER NOT NULL DEFAULT 0;

-- ─── market_posts ─────────────────────────────────────────────────────────────
CREATE TABLE market_posts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id      UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  author_name    TEXT NOT NULL,
  title          TEXT NOT NULL,
  content        TEXT NOT NULL,
  category       TEXT NOT NULL CHECK (category IN ('suggestion','entraide','general','annonce')),
  likes_count    INTEGER NOT NULL DEFAULT 0,
  comments_count INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_market_posts_created ON market_posts(created_at DESC);
CREATE INDEX idx_market_posts_cat     ON market_posts(category);

-- ─── market_comments ─────────────────────────────────────────────────────────
-- parent_id NULL = top-level; parent_id SET = reply (max 1 level, enforced by RPC)
CREATE TABLE market_comments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id     UUID NOT NULL REFERENCES market_posts(id) ON DELETE CASCADE,
  parent_id   UUID REFERENCES market_comments(id) ON DELETE CASCADE,
  author_id   UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  author_name TEXT NOT NULL,
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_market_comments_post ON market_comments(post_id, created_at);

-- ─── post_likes ───────────────────────────────────────────────────────────────
CREATE TABLE post_likes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id    UUID NOT NULL REFERENCES market_posts(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(post_id, user_id)
);

-- ─── Triggers ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION handle_post_like()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE market_posts SET likes_count = likes_count + 1 WHERE id = NEW.post_id;
    UPDATE profiles     SET points      = points + 1
      WHERE id = (SELECT author_id FROM market_posts WHERE id = NEW.post_id);
    RETURN NEW;
  ELSE -- DELETE
    UPDATE market_posts SET likes_count = GREATEST(likes_count - 1, 0) WHERE id = OLD.post_id;
    UPDATE profiles     SET points      = GREATEST(points - 1, 0)
      WHERE id = (SELECT author_id FROM market_posts WHERE id = OLD.post_id);
    RETURN OLD;
  END IF;
END; $$;

CREATE TRIGGER trg_post_like
  AFTER INSERT OR DELETE ON post_likes
  FOR EACH ROW EXECUTE FUNCTION handle_post_like();

CREATE OR REPLACE FUNCTION handle_market_comment()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE market_posts SET comments_count = comments_count + 1 WHERE id = NEW.post_id;
    RETURN NEW;
  ELSE
    UPDATE market_posts SET comments_count = GREATEST(comments_count - 1, 0) WHERE id = OLD.post_id;
    RETURN OLD;
  END IF;
END; $$;

CREATE TRIGGER trg_market_comment
  AFTER INSERT OR DELETE ON market_comments
  FOR EACH ROW EXECUTE FUNCTION handle_market_comment();

-- ─── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE market_posts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_likes      ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Forum: voir les posts"        ON market_posts    FOR SELECT TO authenticated USING (true);
CREATE POLICY "Forum: voir les commentaires" ON market_comments FOR SELECT TO authenticated USING (true);
CREATE POLICY "Forum: voir les likes"        ON post_likes      FOR SELECT TO authenticated USING (true);

-- No direct INSERT on posts/comments — enforced via SECURITY DEFINER RPCs below

-- ─── create_market_post ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION create_market_post(
  p_title       TEXT,
  p_content     TEXT,
  p_category    TEXT,
  p_author_name TEXT
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_id  UUID;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM memberships WHERE user_id = v_uid AND role IN ('administrateur','manager')
  ) THEN RAISE EXCEPTION 'Réservé aux commerçants vérifiés'; END IF;

  IF p_category NOT IN ('suggestion','entraide','general','annonce')
    THEN RAISE EXCEPTION 'Catégorie invalide'; END IF;

  INSERT INTO market_posts(author_id, author_name, title, content, category)
    VALUES (v_uid, p_author_name, p_title, p_content, p_category)
    RETURNING id INTO v_id;

  RETURN v_id;
END; $$;
GRANT EXECUTE ON FUNCTION create_market_post(text, text, text, text) TO authenticated;

-- ─── create_market_comment ────────────────────────────────────────────────────
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
  IF NOT EXISTS (
    SELECT 1 FROM memberships WHERE user_id = v_uid AND role IN ('administrateur','manager')
  ) THEN RAISE EXCEPTION 'Réservé aux commerçants vérifiés'; END IF;

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

-- ─── toggle_post_like ─────────────────────────────────────────────────────────
-- Returns TRUE if the post is now liked, FALSE if unliked.
-- Self-vote guard: a user cannot like their own post.
CREATE OR REPLACE FUNCTION toggle_post_like(p_post_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_uid    UUID    := auth.uid();
  v_exists BOOLEAN;
BEGIN
  -- Prevent self-voting to preserve community reputation integrity
  IF EXISTS (SELECT 1 FROM market_posts WHERE id = p_post_id AND author_id = v_uid) THEN
    RAISE EXCEPTION 'Vous ne pouvez pas aimer votre propre post';
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM post_likes WHERE post_id = p_post_id AND user_id = v_uid
  ) INTO v_exists;

  IF v_exists THEN
    DELETE FROM post_likes WHERE post_id = p_post_id AND user_id = v_uid;
    RETURN FALSE;
  ELSE
    INSERT INTO post_likes(post_id, user_id) VALUES (p_post_id, v_uid);
    RETURN TRUE;
  END IF;
END; $$;
GRANT EXECUTE ON FUNCTION toggle_post_like(uuid) TO authenticated;

-- ─── Realtime ─────────────────────────────────────────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE market_posts;
ALTER PUBLICATION supabase_realtime ADD TABLE market_comments;
