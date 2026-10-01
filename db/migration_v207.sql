-- ============================================================
-- Patron — Migration v207
-- Run in Supabase SQL Editor AFTER migration_v206
--
-- "Espaces sociaux" — Phase 1 + 3 + 5 (pre-launch checklist §7).
-- Three pillars, all server-side so the wall cannot be bypassed
-- from a client:
--
-- PHASE 1 — Signaler / Bloquer / Supprimer (item 1):
--   * reports — ONE moderation queue (id, post_id, motif, détail,
--     reporter_id, état nouveau/en_cours/résolu, created_at). The
--     founder handles everything from a single screen.
--   * blocks — mutual invisibility everywhere. A block is on the
--     ACCOUNT (profiles.id), never on a business or a post.
--   * delete_market_post — immediate for own posts (founder may also
--     delete any post while moderating).
--
-- PHASE 3 — Server-side CONFIGURABLE rate limits (item 3):
--   * 4 posts/hour, 20/day, halved for accounts < 1 day old.
--   * Non-punitive message: "Doucement — vous pourrez republier
--     dans X minutes."
--   * First-post approval on Le Marché as a configurable flag,
--     default ON (app_settings.market_first_post_approval).
--
-- PHASE 5 — Stable visible identity (item 5):
--   * profiles.pseudo — the familiar, chosen pseudo shown in every
--     space. Never the legal name, never imposed from the business
--     name. posts keep resolving to the stable account behind it.
--
-- Safe to re-run (IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY
-- IF EXISTS). Follows migration_v206's idempotent style.
-- ============================================================

-- ─── 0. Config key/value store ──────────────────────────────
-- Founder-only writable app settings. No RLS SELECT for regular
-- users; everything is read through SECURITY DEFINER helpers so a
-- raw PostgREST call can never see or mutate a key.

CREATE TABLE IF NOT EXISTS app_settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "app_settings_founder_only" ON app_settings;
CREATE POLICY "app_settings_founder_only" ON app_settings
  FOR ALL USING (is_founder()) WITH CHECK (is_founder());

-- Seed the three social settings exactly once. Rate limits are ints,
-- the approval flag is 'on'/'off'.
INSERT INTO app_settings (key, value) VALUES
  ('market_rate_limit_hour',        '4'),
  ('market_rate_limit_day',         '20'),
  ('market_first_post_approval',    'on')
ON CONFLICT (key) DO NOTHING;

-- Safe integer reader — never throws on a malformed value.
CREATE OR REPLACE FUNCTION public.get_int_setting(p_key text, p_default int)
RETURNS int
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT COALESCE(
    (SELECT CASE WHEN value ~ '^[0-9]+$' THEN value::int ELSE p_default END
       FROM app_settings WHERE key = p_key),
    p_default
  );
$$;

GRANT EXECUTE ON FUNCTION public.get_int_setting(text, int) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_text_setting(p_key text)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT value FROM app_settings WHERE key = p_key;
$$;

GRANT EXECUTE ON FUNCTION public.get_text_setting(text) TO authenticated;

-- ─── 1. profiles.pseudo — the chosen public identity (Phase 5) ──
-- NULL until the member confirms a pseudo at arrival. Display rules:
--   pseudo (if set) → name fallback → 'Anonyme' is now FORBIDDEN for
--   new content (see the rewritten RPCs below).

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS pseudo text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS pseudo_confirmed_at timestamptz;

-- ─── 2. Reports — ONE moderation queue ───────────────────────

CREATE TABLE IF NOT EXISTS reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id     uuid REFERENCES market_posts(id) ON DELETE CASCADE,
  motif       text NOT NULL,
  detail      text,
  reporter_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  etat        text NOT NULL DEFAULT 'nouveau'
                CHECK (etat IN ('nouveau', 'en_cours', 'resolu')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- One open report per (post, reporter): re-reporting the same post
  -- is a duplicate, not a new signal.
  UNIQUE (post_id, reporter_id)
);

CREATE INDEX IF NOT EXISTS reports_etat_created
  ON reports (etat, created_at ASC);
CREATE INDEX IF NOT EXISTS reports_post
  ON reports (post_id);

ALTER TABLE reports ENABLE ROW LEVEL SECURITY;

-- Founder reads the whole queue. Reporters never read raw report rows
-- directly — their own state comes back from the RPC return values.
DROP POLICY IF EXISTS "reports_founder_select" ON reports;
CREATE POLICY "reports_founder_select" ON reports FOR SELECT
  USING (is_founder());

DROP POLICY IF EXISTS "reports_no_direct_write" ON reports;
CREATE POLICY "reports_no_direct_write" ON reports
  FOR ALL USING (false) WITH CHECK (false);

-- ─── 3. Blocks — account-level mutual invisibility ────────────

CREATE TABLE IF NOT EXISTS blocks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blocker_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

CREATE INDEX IF NOT EXISTS blocks_blocked ON blocks (blocked_id);

ALTER TABLE blocks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "blocks_select_own" ON blocks;
CREATE POLICY "blocks_select_own" ON blocks FOR SELECT
  USING (blocker_id = auth.uid() OR is_founder());

DROP POLICY IF EXISTS "blocks_no_direct_write" ON blocks;
CREATE POLICY "blocks_no_direct_write" ON blocks
  FOR ALL USING (false) WITH CHECK (false);

-- True when either direction blocks the other. SECURITY DEFINER so
-- the RLS policies below can see every row regardless of caller.
CREATE OR REPLACE FUNCTION public.is_blocked_between(p_a uuid, p_b uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM blocks
     WHERE (blocker_id = p_a AND blocked_id = p_b)
        OR (blocker_id = p_b AND blocked_id = p_a)
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_blocked_between(uuid, uuid) TO authenticated;

-- ─── 4. market_posts.status — first-post approval (Phase 3) ───
-- 'approved' is the normal state; 'pending' means the founder hasn't
-- cleared the author's first post yet. Pending posts are visible ONLY
-- to their author and the founder.

ALTER TABLE market_posts ADD COLUMN IF NOT EXISTS status text
  NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'pending'));

CREATE INDEX IF NOT EXISTS market_posts_status ON market_posts (status);

-- RLS: hide pending posts from everyone but the author + founder, and
-- enforce mutual invisibility (blocks) across ALL posts.
DROP POLICY IF EXISTS "Forum: voir les posts" ON market_posts;
CREATE POLICY "Forum: voir les posts" ON market_posts FOR SELECT
  TO authenticated
  USING (
    (status = 'approved' OR author_id = auth.uid() OR is_founder())
    AND NOT is_blocked_between(author_id, auth.uid())
  );

-- RLS: mutual invisibility on comments too.
DROP POLICY IF EXISTS "Forum: voir les commentaires" ON market_comments;
CREATE POLICY "Forum: voir les commentaires" ON market_comments FOR SELECT
  TO authenticated
  USING (NOT is_blocked_between(author_id, auth.uid()));

-- ─── 5. Rewritten create_market_post (rate limits + approval) ──
-- Same 3-arg signature as v44 so the client keeps working, but now:
--   * derives the DISPLAYED identity from pseudo (Phase 5), then name
--   * enforces the configurable rate limits, halved for <1-day accounts
--   * applies first-post approval when the flag is on
--   * never inserts 'Anonyme' (Phase 5 — no anonymous posts)

DROP FUNCTION IF EXISTS public.create_market_post(text, text, text);

CREATE OR REPLACE FUNCTION public.create_market_post(
  p_title    text,
  p_content  text,
  p_category text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid            uuid := auth.uid();
  v_level          int;
  v_identity       text;
  v_id             uuid;
  v_hour_limit     int;
  v_day_limit      int;
  v_account_age    interval;
  v_hour_count     int;
  v_day_count      int;
  v_earliest       timestamptz;
  v_minutes        int;
  v_first_approval boolean;
  v_total_posts    int;
  v_status         text := 'approved';
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Connexion requise' USING ERRCODE = 'P0001';
  END IF;

  -- Community-level gate (unchanged from v44): admins bypass.
  IF NOT EXISTS (
    SELECT 1 FROM memberships WHERE user_id = v_uid AND role = 'administrateur'
  ) THEN
    SELECT community_level INTO v_level FROM profiles WHERE id = v_uid;
    IF COALESCE(v_level, 1) < 2 THEN
      RAISE EXCEPTION 'Participez aux discussions et obtenez 5 likes pour débloquer la publication' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF p_category NOT IN ('suggestion', 'entraide', 'general', 'annonce') THEN
    RAISE EXCEPTION 'Catégorie invalide' USING ERRCODE = 'P0001';
  END IF;

  -- ── Rate limits (configurable, halved for fresh accounts) ──
  v_hour_limit := get_int_setting('market_rate_limit_hour', 4);
  v_day_limit  := get_int_setting('market_rate_limit_day', 20);

  SELECT (now() - created_at) INTO v_account_age FROM profiles WHERE id = v_uid;
  IF v_account_age < interval '1 day' THEN
    v_hour_limit := GREATEST(1, v_hour_limit / 2);
    v_day_limit  := GREATEST(1, v_day_limit  / 2);
  END IF;

  SELECT count(*) INTO v_hour_count FROM market_posts
   WHERE author_id = v_uid AND created_at > now() - interval '1 hour';
  IF v_hour_count >= v_hour_limit THEN
    SELECT min(created_at) INTO v_earliest FROM market_posts
     WHERE author_id = v_uid AND created_at > now() - interval '1 hour';
    v_minutes := 60 - floor(EXTRACT(EPOCH FROM (now() - v_earliest)) / 60);
    IF v_minutes < 1 THEN v_minutes := 1; END IF;
    RAISE EXCEPTION 'Doucement — vous pourrez republier dans % minutes.', v_minutes USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_day_count FROM market_posts
   WHERE author_id = v_uid AND created_at > now() - interval '24 hours';
  IF v_day_count >= v_day_limit THEN
    SELECT min(created_at) INTO v_earliest FROM market_posts
     WHERE author_id = v_uid AND created_at > now() - interval '24 hours';
    v_minutes := 1440 - floor(EXTRACT(EPOCH FROM (now() - v_earliest)) / 60);
    IF v_minutes < 1 THEN v_minutes := 1; END IF;
    RAISE EXCEPTION 'Doucement — vous pourrez republier dans % minutes.', v_minutes USING ERRCODE = 'P0001';
  END IF;

  -- ── First-post approval (configurable, default ON) ──
  SELECT count(*) INTO v_total_posts FROM market_posts WHERE author_id = v_uid;
  SELECT COALESCE(get_text_setting('market_first_post_approval'), 'on') = 'on'
    INTO v_first_approval;
  IF v_first_approval AND v_total_posts = 0 THEN
    v_status := 'pending';
  END IF;

  -- ── Identity: pseudo first, then name. Never anonymous. ──
  SELECT COALESCE(NULLIF(btrim(pseudo), ''), NULLIF(btrim(name), ''))
    INTO v_identity
    FROM profiles WHERE id = v_uid;
  IF v_identity IS NULL OR btrim(v_identity) = '' THEN
    RAISE EXCEPTION 'Votre pseudo est requis pour publier.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO market_posts(author_id, author_name, title, content, category, status)
    VALUES (v_uid, v_identity, p_title, p_content, p_category, v_status)
    RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_market_post(text, text, text) TO authenticated;

-- ─── 6. Rewritten create_market_comment (identity + blocks) ──
-- Same 3-arg signature as v44. Derives pseudo/name server-side and
-- refuses anonymous comments.

DROP FUNCTION IF EXISTS public.create_market_comment(uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.create_market_comment(
  p_post_id   uuid,
  p_parent_id uuid,
  p_content   text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      uuid := auth.uid();
  v_identity text;
  v_id       uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Connexion requise' USING ERRCODE = 'P0001';
  END IF;

  IF p_parent_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM market_comments WHERE id = p_parent_id AND parent_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Maximum un niveau de réponse autorisé' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(NULLIF(btrim(pseudo), ''), NULLIF(btrim(name), ''))
    INTO v_identity
    FROM profiles WHERE id = v_uid;
  IF v_identity IS NULL OR btrim(v_identity) = '' THEN
    RAISE EXCEPTION 'Votre pseudo est requis pour commenter.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO market_comments(post_id, parent_id, author_id, author_name, content)
    VALUES (p_post_id, p_parent_id, v_uid, v_identity, p_content)
    RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_market_comment(uuid, uuid, text) TO authenticated;

-- ─── 7. Report a post ────────────────────────────────────────
-- Any authenticated member. Motif is one of the fixed conduct codes.
-- Duplicate (same post + reporter) is refused with a clear message.

CREATE OR REPLACE FUNCTION public.report_post(
  p_post_id uuid,
  p_motif   text,
  p_detail  text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_author uuid;
  v_id     uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Connexion requise' USING ERRCODE = 'P0001';
  END IF;

  IF p_motif NOT IN (
    'harcelement', 'donnees_privees', 'spam', 'mauvais_espace', 'autre'
  ) THEN
    RAISE EXCEPTION 'Motif invalide' USING ERRCODE = 'P0001';
  END IF;

  SELECT author_id INTO v_author FROM market_posts WHERE id = p_post_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Post introuvable' USING ERRCODE = 'P0001';
  END IF;
  IF v_author = v_uid THEN
    RAISE EXCEPTION 'Vous ne pouvez pas signaler votre propre post' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO reports (post_id, motif, detail, reporter_id)
    VALUES (p_post_id, p_motif, NULLIF(btrim(COALESCE(p_detail, '')), ''), v_uid)
    ON CONFLICT (post_id, reporter_id) DO NOTHING
    RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Vous avez déjà signalé ce post' USING ERRCODE = 'P0001';
  END IF;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.report_post(uuid, text, text) TO authenticated;

-- ─── 8. Moderation queue (founder, single screen) ────────────
-- Sorted by recency/gravity: most-reported posts first, then oldest
-- unreviewed first — so the founder can triage in under 5 minutes.

CREATE OR REPLACE FUNCTION public.list_reports()
RETURNS TABLE (
  id                uuid,
  post_id           uuid,
  post_title        text,
  post_excerpt      text,
  post_author_id    uuid,
  post_author_name  text,
  motif             text,
  detail            text,
  reporter_id       uuid,
  etat              text,
  created_at        timestamptz,
  report_count      bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT r.id,
         r.post_id,
         mp.title,
         left(mp.content, 160),
         mp.author_id,
         mp.author_name,
         r.motif,
         r.detail,
         r.reporter_id,
         r.etat,
         r.created_at,
         (SELECT count(*) FROM reports r2 WHERE r2.post_id = r.post_id)::bigint
    FROM reports r
    LEFT JOIN market_posts mp ON mp.id = r.post_id
   WHERE is_founder()
   ORDER BY (SELECT count(*) FROM reports r2 WHERE r2.post_id = r.post_id) DESC,
            r.created_at ASC;
$$;

GRANT EXECUTE ON FUNCTION public.list_reports() TO authenticated;

-- ─── 9. Update report status (founder only) ──────────────────

CREATE OR REPLACE FUNCTION public.update_report_status(
  p_report_id uuid,
  p_etat      text
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
  IF p_etat NOT IN ('nouveau', 'en_cours', 'resolu') THEN
    RAISE EXCEPTION 'État invalide' USING ERRCODE = 'P0001';
  END IF;

  UPDATE reports SET etat = p_etat WHERE id = p_report_id;
  RETURN FOUND;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_report_status(uuid, text) TO authenticated;

-- ─── 10. Delete a post (own post immediately; founder while moderating) ──

CREATE OR REPLACE FUNCTION public.delete_market_post(p_post_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_author uuid;
BEGIN
  SELECT author_id INTO v_author FROM market_posts WHERE id = p_post_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_author <> auth.uid() AND NOT is_founder() THEN
    RAISE EXCEPTION 'Vous ne pouvez supprimer que vos propres posts' USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM market_posts WHERE id = p_post_id;
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_market_post(uuid) TO authenticated;

-- ─── 11. Block / unblock an account ──────────────────────────
-- Block acts on the ACCOUNT (profiles.id). Founder may block anyone
-- while moderating; every member may block any other member.

CREATE OR REPLACE FUNCTION public.block_user(p_blocked_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Connexion requise' USING ERRCODE = 'P0001';
  END IF;
  IF p_blocked_id IS NULL OR p_blocked_id = v_uid THEN
    RAISE EXCEPTION 'Bloquer est impossible' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO blocks (blocker_id, blocked_id)
    VALUES (v_uid, p_blocked_id)
    ON CONFLICT (blocker_id, blocked_id) DO NOTHING;
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.block_user(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.unblock_user(p_blocked_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM blocks
   WHERE blocker_id = auth.uid() AND blocked_id = p_blocked_id;
  RETURN FOUND;
END;
$$;

GRANT EXECUTE ON FUNCTION public.unblock_user(uuid) TO authenticated;

-- List of account ids I have blocked (for hiding actions on cards).
CREATE OR REPLACE FUNCTION public.list_my_blocks()
RETURNS TABLE (blocked_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT blocked_id FROM blocks WHERE blocker_id = auth.uid();
$$;

GRANT EXECUTE ON FUNCTION public.list_my_blocks() TO authenticated;

-- ─── 12. Confirm my pseudo at arrival (Phase 5) ──────────────
-- Chosen by the member, never imposed. Pseudo must be 2-30 chars,
-- trimmable, and unique among confirmed pseudos (case-insensitive)
-- so every post resolves to one stable account.

CREATE OR REPLACE FUNCTION public.confirm_pseudo(p_pseudo text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_p   text := btrim(COALESCE(p_pseudo, ''));
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Connexion requise' USING ERRCODE = 'P0001';
  END IF;

  IF length(v_p) < 2 OR length(v_p) > 30 THEN
    RAISE EXCEPTION 'Le pseudo doit contenir entre 2 et 30 caractères' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM profiles
     WHERE lower(pseudo) = lower(v_p) AND id <> v_uid
  ) THEN
    RAISE EXCEPTION 'Ce pseudo est déjà pris' USING ERRCODE = 'P0001';
  END IF;

  UPDATE profiles SET pseudo = v_p, pseudo_confirmed_at = now() WHERE id = v_uid;
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.confirm_pseudo(text) TO authenticated;
