-- migration_v233 — Phase 9, Finding 5: pin search_path on every public function.
--
-- WHY. A SECURITY DEFINER function with no pinned search_path resolves
-- unqualified table names against the CALLER's search_path (Supabase linter:
-- function_search_path_mutable). `SET search_path = public` alone is not
-- enough either: Postgres searches the caller's temporary schema (pg_temp)
-- FIRST for relations unless it is named explicitly, so a caller who can
-- create a temp table can shadow `market_posts`/`profiles`/... inside the
-- definer body. Measured on the replayed schema before this migration: with a
-- temp `market_posts` whose author_id is NULL, toggle_post_like() let an author
-- like their own post (self-like guard + 3/day pair cap both read author_id).
-- The correct pin is `public, pg_temp` (pg_temp LAST).
--
-- WHAT. Enumerated programmatically, not from a hand-kept list: every function
-- in schema public (not extension-owned) that has NO search_path in proconfig
-- gets `SET search_path = public, pg_temp`. On the replayed schema that is 19
-- functions: the 8 SECURITY DEFINER ones (create_boutique_room,
-- create_market_comment, create_market_post, toggle_comment_like,
-- toggle_post_like, receive_purchase_order(uuid,uuid,uuid) — the stale
-- service_role-only overload —, update_chat_message_edited_at,
-- update_market_post_edited_at) and 11 invoker ones (merchant-level/points
-- triggers, referral/djomi token generators, trial/updated_at triggers).
-- ALTER FUNCTION ... SET changes configuration only — no body is touched, so
-- behaviour is identical. Every body was read: all cross-schema references are
-- already schema-qualified (auth.uid()) or pg_catalog (now(), gen_random_uuid(),
-- md5(), random()), so `public, pg_temp` resolves exactly what they resolved.
--
-- NOT DONE here (recorded in the PR): 139 older SECURITY DEFINER functions (and 3 invoker ones) pin
-- `public` WITHOUT pg_temp (v228-era style) and remain shadowable by a caller
-- with a temp table. Fixing them is the same one-line ALTER each, but it touches
-- the money RPCs (submit_sale, ...) and cannot be proven here without the full
-- PostgREST suite — proposed as its own reviewed change.

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS fn
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.prokind = 'f'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
      AND NOT EXISTS (
        SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%')
  LOOP
    BEGIN
      EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', r.fn);
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE WARNING 'migration_v233: not the owner of %, search_path NOT pinned — alter it as its owner', r.fn;
    END;
  END LOOP;
END $$;

-- The two LIVE Le Marché writers (v207 3-arg signatures) already pin `public`
-- but, per the above, that leaves pg_temp first. They are part of the audited
-- set (create_market_post / create_market_comment), so pin them correctly too.
DO $$
BEGIN
  IF to_regprocedure('public.create_market_post(text,text,text)') IS NOT NULL THEN
    ALTER FUNCTION public.create_market_post(text, text, text) SET search_path = public, pg_temp;
  END IF;
  IF to_regprocedure('public.create_market_comment(uuid,uuid,text)') IS NOT NULL THEN
    ALTER FUNCTION public.create_market_comment(uuid, uuid, text) SET search_path = public, pg_temp;
  END IF;
END $$;

-- Legacy 4-arg overloads of the Le Marché writers (caller-supplied author_name).
-- migration_v44 "REVOKE ... FROM authenticated" on them, but a function's default
-- EXECUTE comes from PUBLIC (and a direct anon grant on Supabase), which that
-- REVOKE never touched — so they stayed callable by every signed-in user (and,
-- through a bare create_business, by an "administrateur" who skips the
-- community-level gate), bypassing v207's server-derived identity, rate limits
-- and first-post approval. The app only ever calls the 3-arg signatures
-- (stores/market.ts), which are untouched.
DO $$
BEGIN
  IF to_regprocedure('public.create_market_post(text,text,text,text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.create_market_post(text, text, text, text) FROM PUBLIC, anon, authenticated;
  END IF;
  IF to_regprocedure('public.create_market_comment(uuid,uuid,text,text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.create_market_comment(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
  END IF;
END $$;
