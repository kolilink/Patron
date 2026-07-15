-- ============================================================
-- Patron — Migration v150
-- Security hardening (see security audit 2026-07-14):
--   H1  invite_codes: remove the anonymous "read ALL codes" hole
--   M3  is_member()/get_role(): pin search_path
-- Run in Supabase SQL Editor. Idempotent.
-- ============================================================

-- ─── H1: anonymous users could read every business's invite codes ────────────
-- migration_v8.sql's "invite_codes_read" policy OR'd in a branch that matched
-- EVERY row for any anonymous session:
--   USING ( is_member(business_id)
--           OR (auth.jwt()->>'is_anonymous')::boolean IS TRUE )
-- signInAnonymously() is a normal call against the public anon key (used all
-- over stores/auth.ts), so anyone could obtain an anonymous JWT and
-- `SELECT * FROM invite_codes` across ALL tenants — leaking every code value,
-- business_id and role, and enabling unauthorized joins via join_business().
--
-- That anonymous branch is dead code for the app: the join flow goes entirely
-- through the validate_invite_code()/join_business() SECURITY DEFINER RPCs
-- (v21/v43), which bypass RLS and never need a client-side SELECT. The only
-- direct reads are team-management (stores/equipe.ts), which are member reads.
-- So we keep the is_member() branch and drop only the anonymous one.
DROP POLICY IF EXISTS "invite_codes_read" ON invite_codes;
CREATE POLICY "invite_codes_read"
  ON invite_codes FOR SELECT
  TO authenticated
  USING (is_member(business_id));

-- ─── M3: pin search_path on the two foundational RLS helpers ─────────────────
-- is_member()/get_role() (db/schema.sql) gate EVERY RLS policy in the app but,
-- unlike every other SECURITY DEFINER function in this codebase, never set a
-- search_path. That's the Supabase-linter `function_search_path_mutable`
-- finding: with a mutable search_path, an unqualified `memberships` reference
-- inside a definer function can in principle be shadowed by an object in a
-- schema resolved ahead of `public`, running as the definer — a total
-- tenant-isolation bypass. Pinning search_path closes that class outright.
-- No behavior change: `public` is where these objects already resolve.
ALTER FUNCTION public.is_member(uuid) SET search_path = public;
ALTER FUNCTION public.get_role(uuid)  SET search_path = public;
