-- ============================================================
-- Patron — Migration v44
-- Fixes H1: author name spoofing in forum posts and comments.
-- create_market_post and create_market_comment previously
-- accepted p_author_name as a caller-supplied string and stored
-- it verbatim — any user could post as "Admin" or any other name.
-- Fix: derive author_name server-side from profiles, ignore the
-- client-supplied value entirely.
-- ============================================================

-- ─── create_market_post: derive author_name from profiles ────────────────────
CREATE OR REPLACE FUNCTION create_market_post(
  p_title    TEXT,
  p_content  TEXT,
  p_category TEXT
  -- p_author_name removed: name is fetched from profiles inside the RPC
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_uid         UUID := auth.uid();
  v_level       INTEGER;
  v_author_name TEXT;
  v_id          UUID;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Non authentifié'; END IF;

  IF NOT EXISTS (SELECT 1 FROM memberships WHERE user_id = v_uid AND role = 'administrateur') THEN
    SELECT community_level INTO v_level FROM profiles WHERE id = v_uid;
    IF COALESCE(v_level, 1) < 2 THEN
      RAISE EXCEPTION 'Participez aux discussions et obtenez 5 likes pour débloquer la publication';
    END IF;
  END IF;

  IF p_category NOT IN ('suggestion', 'entraide', 'general')
    THEN RAISE EXCEPTION 'Catégorie invalide'; END IF;

  -- Server-side name: cannot be spoofed
  SELECT name INTO v_author_name FROM profiles WHERE id = v_uid;

  INSERT INTO market_posts(author_id, author_name, title, content, category)
    VALUES (v_uid, COALESCE(v_author_name, 'Anonyme'), p_title, p_content, p_category)
    RETURNING id INTO v_id;

  RETURN v_id;
END; $$;

-- Revoke old 4-arg signature, grant the new 3-arg one
REVOKE EXECUTE ON FUNCTION create_market_post(text, text, text, text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION create_market_post(text, text, text)       TO authenticated;


-- ─── create_market_comment: derive author_name from profiles ─────────────────
CREATE OR REPLACE FUNCTION create_market_comment(
  p_post_id   UUID,
  p_parent_id UUID,
  p_content   TEXT
  -- p_author_name removed: name is fetched from profiles inside the RPC
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_uid         UUID := auth.uid();
  v_author_name TEXT;
  v_id          UUID;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Non authentifié'; END IF;

  IF p_parent_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM market_comments WHERE id = p_parent_id AND parent_id IS NOT NULL
  ) THEN RAISE EXCEPTION 'Maximum un niveau de réponse autorisé'; END IF;

  -- Server-side name: cannot be spoofed
  SELECT name INTO v_author_name FROM profiles WHERE id = v_uid;

  INSERT INTO market_comments(post_id, parent_id, author_id, author_name, content)
    VALUES (p_post_id, p_parent_id, v_uid, COALESCE(v_author_name, 'Anonyme'), p_content)
    RETURNING id INTO v_id;

  RETURN v_id;
END; $$;

-- Revoke old 4-arg signature, grant the new 3-arg one
REVOKE EXECUTE ON FUNCTION create_market_comment(uuid, uuid, text, text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION create_market_comment(uuid, uuid, text)       TO authenticated;
