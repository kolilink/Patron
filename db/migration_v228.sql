-- ============================================================
-- Patron — Migration v228
-- Run in Supabase SQL Editor AFTER migration_v227
--
-- SECURITY BATCH (P0 + P1 from the database review).
--
-- NOT touched here (already fixed by v225/v226 — only verified not to regress):
--   v225: edit_withdrawal, record_payment, void_payment,
--         void_purchase_order_receipt, attach_transaction_proof,
--         delete_transaction_proof, delete_market_post, mark_support_read,
--         submit_support_rating
--   v226: get_reports_snapshot, get_period_report
--
-- A. Function exposure
-- B. Storage object policies (cross-business read/write/delete)
-- C. Auth chain: phone is written only server-side; upgrade_anonymous_user gated
-- D. RLS WITH CHECK gaps (market_posts, chat_messages, so_lines)
-- ============================================================


-- ============================================================
-- A. FUNCTION EXPOSURE
-- ============================================================

-- A1. get_financial_snapshot() (v103): a cross-business ledger recompute with
-- NO auth check, executable by anon. Its only caller is the reconciliation
-- edge code (supabase/functions/_shared/reconciliation.ts) through a
-- SERVICE_ROLE client. service_role only.
REVOKE ALL ON FUNCTION public.get_financial_snapshot() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_financial_snapshot() TO service_role;

-- A2. get_best_sellers / get_order_cogs: SECURITY DEFINER (RLS bypassed) and
-- took any p_business_id from anyone, anon included. The original bodies are
-- LANGUAGE sql (cannot RAISE), and are kept BYTE-FOR-BYTE UNTOUCHED under
-- private *_unchecked names (service_role only); the public functions become
-- thin plpgsql wrappers that add ONLY the membership guard and delegate.
--
-- Why a wrapper instead of rewriting the body as plpgsql: plpgsql's
-- RETURN QUERY demands the query's column types match RETURNS TABLE EXACTLY,
-- while a LANGUAGE sql body coerces. Production's so_lines.unit_price is `real`
-- (float4; the migration-replayed schema has bigint), so SUM(qty * unit_price) is
-- double precision, not numeric — an in-place plpgsql rewrite passed every local
-- test and then errored "structure of query does not match function result
-- type" for every member in production (caught by the post-deploy probe).
-- Delegating to the unchanged SQL function keeps the exact coercion behaviour
-- on any schema. (The wrapper's SELECT * FROM f() also yields exactly the
-- declared types, which is what RETURN QUERY needs.)
CREATE OR REPLACE FUNCTION public.get_best_sellers_unchecked(p_business_id uuid, p_month_start date, p_limit integer DEFAULT 5)
 RETURNS TABLE(product_id uuid, product_name text, total_qty numeric, total_revenue numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    sl.product_id,
    p.name           AS product_name,
    SUM(sl.qty)                  AS total_qty,
    SUM(sl.qty * sl.unit_price)  AS total_revenue
  FROM so_lines sl
  JOIN products p     ON p.id  = sl.product_id
  JOIN sale_orders so ON so.id = sl.order_id
  WHERE so.business_id = p_business_id
    AND so.status IN ('paye', 'credit')
    AND so.sale_date >= p_month_start
    AND p.archived = false
    AND p.is_system = false
  GROUP BY sl.product_id, p.name
  ORDER BY total_revenue DESC
  LIMIT p_limit;
$function$;
REVOKE ALL ON FUNCTION public.get_best_sellers_unchecked(uuid, date, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_best_sellers_unchecked(uuid, date, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.get_best_sellers(p_business_id uuid, p_month_start date, p_limit integer DEFAULT 5)
 RETURNS TABLE(product_id uuid, product_name text, total_qty numeric, total_revenue numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY SELECT * FROM public.get_best_sellers_unchecked(p_business_id, p_month_start, p_limit);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_order_cogs_unchecked(p_business_id uuid, p_since_date date)
 RETURNS TABLE(order_id uuid, cogs_cents bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    sl.order_id,
    SUM(
      COALESCE(
        sl.cost_price_at_sale,
        pv.cost_price,
        p.cost_price,
        0
      ) * sl.qty
    )::bigint AS cogs_cents
  FROM so_lines sl
  JOIN products p               ON p.id  = sl.product_id
  LEFT JOIN product_variants pv ON pv.id = sl.variant_id
  WHERE sl.order_id IN (
    SELECT DISTINCT pay.order_id
    FROM payments pay
    JOIN sale_orders so ON so.id = pay.order_id
    WHERE so.business_id = p_business_id
      AND so.status     != 'annule'
      AND pay.date      >= p_since_date
  )
  GROUP BY sl.order_id;
$function$;
REVOKE ALL ON FUNCTION public.get_order_cogs_unchecked(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_order_cogs_unchecked(uuid, date) TO service_role;

CREATE OR REPLACE FUNCTION public.get_order_cogs(p_business_id uuid, p_since_date date)
 RETURNS TABLE(order_id uuid, cogs_cents bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY SELECT * FROM public.get_order_cogs_unchecked(p_business_id, p_since_date);
END;
$function$;

REVOKE ALL ON FUNCTION public.get_best_sellers(uuid, date, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_order_cogs(uuid, date)            FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_best_sellers(uuid, date, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_order_cogs(uuid, date)            TO authenticated, service_role;

-- A3. Reconciliation job functions: no auth check, executable by anon (and by
-- every logged-in user — they can spam reconciliation_runs / findings). Their
-- only caller is _shared/reconciliation.ts via a SERVICE_ROLE client, so
-- service_role only (authenticated is revoked too: it has no legitimate caller).
-- No body change.
REVOKE ALL ON FUNCTION public.run_reconciliation()                      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.run_variant_price_checks(uuid)            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.run_display_checks(uuid)                  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.run_supplier_payment_checks(uuid)         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_reconciliation_run(uuid)          FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_reconciliation()                   TO service_role;
GRANT EXECUTE ON FUNCTION public.run_variant_price_checks(uuid)         TO service_role;
GRANT EXECUTE ON FUNCTION public.run_display_checks(uuid)               TO service_role;
GRANT EXECUTE ON FUNCTION public.run_supplier_payment_checks(uuid)      TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_reconciliation_run(uuid)       TO service_role;

-- A4. get_int_setting / get_text_setting (v207): read app_settings for ANY key
-- as anon. Caller audit: no client, edge function, policy, view or cron job
-- calls them; the only callers are other SECURITY DEFINER functions owned by
-- postgres (create_market_post), whose own privilege check is unaffected by
-- this REVOKE. So there is no legitimate client path: revoke authenticated too.
REVOKE ALL ON FUNCTION public.get_int_setting(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_text_setting(text)         FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_int_setting(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_text_setting(text)         TO service_role;


-- A5. Legacy helpers with no auth check and no REVOKE (found by the new
-- function-exposure lint, scripts/lib/function-exposure.js). No body change.
--   use_invite_code(code_id): SECURITY DEFINER `UPDATE invite_codes SET uses =
--     uses + 1` with NO check — anyone could burn an invite code. Nothing calls
--     it (join_business() replaced it): service_role only.
--   get_founder_id / has_ai_access / resolve_referral_code / is_blocked_between
--     leak the founder's user id, any business's subscription state, referrer
--     ids and block relationships to anon.
--   The rest are token generators / pure helpers / RLS-trigger helpers.
-- anon is revoked (authenticated + service_role keep EXECUTE: RLS policies and
-- the app's own calls — e.g. resolve_referral_code at signup — run as
-- authenticated). preview_consumer_invite / preview_consumer_invite_code stay
-- anon-callable ON PURPOSE (the public invite landing page, supabase/functions/
-- invite, calls them with the anon key; they return only validity + the
-- inviter's display name) — allowlisted in the lint with that reason.
REVOKE ALL ON FUNCTION public.use_invite_code(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.use_invite_code(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.get_founder_id()                       FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.has_ai_access(uuid)                    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.resolve_referral_code(text)            FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_blocked_between(uuid, uuid)         FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.generate_business_referral_code()      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.generate_djomi_checkout_token()        FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.business_has_manager(uuid)             FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.count_joined_businesses(uuid)          FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.count_business_admins(uuid)            FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.calculate_merchant_level(integer)      FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_founder_id()                    TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.has_ai_access(uuid)                 TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_referral_code(text)         TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_blocked_between(uuid, uuid)      TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.generate_business_referral_code()   TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.generate_djomi_checkout_token()     TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.business_has_manager(uuid)          TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.count_joined_businesses(uuid)       TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.count_business_admins(uuid)         TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.calculate_merchant_level(integer)   TO authenticated, service_role;

-- A6. Found by the live-ACL backstop test (function-exposure-live), invisible to
-- the static scan until it was fixed to require BOTH PUBLIC and anon revoked:
--   * create_demo_business(uuid, uuid) — SECURITY DEFINER, inserts a `businesses`
--     row for ANY p_business_id/p_user_id. migration_v77 revoked it from
--     anon + authenticated, but Postgres' default EXECUTE-to-PUBLIC still let
--     both call it (REVOKE ... FROM anon does not remove access that comes via
--     PUBLIC). Demo mode is removed and nothing calls it: service_role only.
--   * receive_purchase_order(uuid, uuid, uuid) — a stale 3-arg overload (before
--     confirm_reception / the role gate existed): SECURITY DEFINER, NO auth
--     check, takes a caller-supplied user id, executable by anon. The app calls
--     the 5-arg overload (stores/fournisseurs.ts) and confirm_reception PERFORMs
--     the 5-arg one, so nothing uses this: service_role only. (Left in place
--     rather than dropped so a surprise caller fails loudly instead of
--     vanishing; dropping it is a safe follow-up.)
REVOKE ALL ON FUNCTION public.create_demo_business(uuid, uuid)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.receive_purchase_order(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_demo_business(uuid, uuid)       TO service_role;
GRANT EXECUTE ON FUNCTION public.receive_purchase_order(uuid, uuid, uuid) TO service_role;

-- ============================================================
-- B. STORAGE OBJECT POLICIES
-- ============================================================
-- Before: every policy on storage.objects only checked
--   auth.uid() IS NOT NULL
-- so ANY logged-in user (an anonymous demo/OTP session included) could read,
-- upload into and delete every business's proof / chat / voice objects.
--
-- Object-path convention (read from the upload code, see lib/proofs.ts,
-- lib/chatImages.ts, stores/chat.ts, stores/supportChat.ts,
-- app/(app)/messages/[room_id].tsx):
--   transaction-proofs : {kind}/{business_id}/{transaction_id}.jpg
--   message-images     : chat/{room_id}/{message_id}.jpg
--                        support/{conversation_id | business_id}/{message_id}.jpg
--   voice-messages     : {uploader's business_id}/{message_id}.m4a
--
-- NOTE: all three buckets are PUBLIC (getPublicUrl is stored in the message
-- rows). Supabase Storage serves public-bucket DOWNLOADS (public AND
-- authenticated routes, verified on the local stack) without consulting RLS, so
-- these policies gate list / info / upload / overwrite / delete — NOT a
-- download by URL. Closing that needs private buckets + signed URLs (a client
-- change to every image/voice render) — deliberately out of scope here and
-- flagged as the remaining storage exposure.

-- Safe uuid cast for path segments: a malformed folder name must yield NULL
-- (policy => false), never a cast error that breaks the whole query.
CREATE OR REPLACE FUNCTION public.try_uuid(p_text text)
 RETURNS uuid
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN p_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN p_text::uuid
    ELSE NULL
  END;
$function$;
REVOKE ALL ON FUNCTION public.try_uuid(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.try_uuid(text) TO authenticated, service_role;

-- message-images ownership: SECURITY INVOKER on purpose, so the existing RLS on
-- chat_rooms / support_conversations is what decides — the exact same rule the
-- messages themselves obey (own business room, an accepted partnership DM for
-- admin/manager, the merchant's own support thread, the founder). Global
-- (Le Marché) rooms are NOT business-owned: image objects there are denied
-- (images in Le Marché are excluded by product decision).
CREATE OR REPLACE FUNCTION public.message_image_allowed(p_name text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE (storage.foldername(p_name))[1]
    WHEN 'chat' THEN EXISTS (
      SELECT 1 FROM chat_rooms cr
      WHERE cr.id = try_uuid((storage.foldername(p_name))[2]) AND cr.is_global = false
    )
    WHEN 'support' THEN
      is_founder()
      OR EXISTS (SELECT 1 FROM support_conversations sc WHERE sc.id = try_uuid((storage.foldername(p_name))[2]))
      OR is_member(try_uuid((storage.foldername(p_name))[2]))
    ELSE false
  END;
$function$;
REVOKE ALL ON FUNCTION public.message_image_allowed(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.message_image_allowed(text) TO authenticated, service_role;

DROP POLICY IF EXISTS "transaction proofs read"   ON storage.objects;
DROP POLICY IF EXISTS "transaction proofs upload" ON storage.objects;
DROP POLICY IF EXISTS "message images read"       ON storage.objects;
DROP POLICY IF EXISTS "message images upload"     ON storage.objects;
DROP POLICY IF EXISTS "message images delete"     ON storage.objects;
DROP POLICY IF EXISTS "voice read"                ON storage.objects;
DROP POLICY IF EXISTS "voice upload"              ON storage.objects;
DROP POLICY IF EXISTS "voice delete"              ON storage.objects;

-- transaction-proofs: {kind}/{business_id}/... — members of that business.
-- (No UPDATE/DELETE policy existed and none is added: proofs are add-once at
-- the DB level, see delete_transaction_proof.)
CREATE POLICY "transaction proofs read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'transaction-proofs'
         AND public.is_member(public.try_uuid((storage.foldername(name))[2])));
CREATE POLICY "transaction proofs upload" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'transaction-proofs'
              AND public.is_member(public.try_uuid((storage.foldername(name))[2])));

-- message-images
CREATE POLICY "message images read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'message-images' AND public.message_image_allowed(name));
CREATE POLICY "message images upload" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'message-images' AND public.message_image_allowed(name));
CREATE POLICY "message images delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'message-images' AND public.message_image_allowed(name));

-- voice-messages: {uploader's business_id}/... — members of that business.
-- ("voice read" existed in the repo's replay as the same auth.uid()-only check
-- but was absent from the production dump; dropped and recreated scoped so every
-- environment ends with the same 8 policies. Playback uses the public URL.)
CREATE POLICY "voice read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'voice-messages'
         AND public.is_member(public.try_uuid((storage.foldername(name))[1])));
CREATE POLICY "voice upload" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'voice-messages'
              AND public.is_member(public.try_uuid((storage.foldername(name))[1])));
CREATE POLICY "voice delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'voice-messages'
         AND public.is_member(public.try_uuid((storage.foldername(name))[1])));


-- ============================================================
-- C. AUTH CHAIN
-- ============================================================
-- Invariant: profiles.phone is written ONLY server-side. The client used to
-- upsert its own phone in upgradePhone() and then call the ungated
-- upgrade_anonymous_user() — so any anonymous session (one free, unthrottled
-- signInAnonymously() call) could claim any unclaimed phone number AND lift
-- its own anonymous flag with no OTP at all.

-- C2. upgrade_anonymous_user(): only flips is_anonymous for a caller that has a
-- COMPLETED phone verification (phone_verifications.status = 'verifie' for
-- auth.uid(), set by verify-phone-code after the correct code). The phone is
-- taken FROM that verification (never from the client) and written to the
-- profile here, as the definer. Idempotent for an already-permanent user.
CREATE OR REPLACE FUNCTION public.upgrade_anonymous_user()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid   uuid := auth.uid();
  v_phone text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  -- Already a permanent user: nothing to do (keeps repeated calls harmless).
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_uid AND is_anonymous = true) THEN
    RETURN;
  END IF;

  SELECT pv.phone INTO v_phone
  FROM phone_verifications pv
  WHERE pv.user_id = v_uid AND pv.status = 'verifie'
  ORDER BY pv.created_at DESC
  LIMIT 1;

  IF v_phone IS NULL OR v_phone = '' THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  -- The verified number must not already belong to another account (a login
  -- verification is a verification too, but it must never mint a duplicate).
  IF EXISTS (SELECT 1 FROM profiles p WHERE p.phone = v_phone AND p.id <> v_uid) THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  UPDATE profiles SET phone = v_phone WHERE id = v_uid;

  UPDATE auth.users
  SET is_anonymous = false,
      updated_at   = now()
  WHERE id = v_uid
    AND is_anonymous = true;
END;
$function$;
-- Grants unchanged (CREATE OR REPLACE keeps them): authenticated must call it.
-- An anon-KEY caller has auth.uid() NULL and is refused in the body; revoke the
-- anon grant too so the refusal is at the privilege layer.
REVOKE ALL ON FUNCTION public.upgrade_anonymous_user() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upgrade_anonymous_user() TO authenticated, service_role;

-- C3. profiles.phone is immutable from the client.
--   UPDATE: WITH CHECK pins phone to its pre-update value (read via
--           profile_phone(), below). Name / language / notification edits keep
--           working; any statement that changes phone is rejected.
--   INSERT: a client may only create its own profile row with NO phone (the
--           auth trigger already creates the row on sign-in; upsert paths in
--           the app never send a phone on insert — checked in stores/auth.ts).
-- Server-side writers are unaffected: service_role (edge functions) and
-- SECURITY DEFINER functions (upgrade_anonymous_user) bypass RLS.
-- The UPDATE pin reads the OLD phone through a helper rather than a subquery on
-- profiles: a subquery on the policy's own table makes Postgres raise
-- "infinite recursion detected in policy for relation profiles" (42P17) as soon
-- as the table's SELECT policies chain back through memberships — which would
-- have broken EVERY profile edit. The helper is SECURITY DEFINER (no RLS, so no
-- recursion), STABLE on purpose (a STABLE function runs on the calling
-- statement's snapshot, i.e. it sees the pre-update row; a VOLATILE one would
-- see the new row and the pin would pass vacuously), and returns ONLY the
-- caller's own phone (NULL for anyone else) so it can never leak a number.
CREATE OR REPLACE FUNCTION public.profile_phone(p_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p.phone FROM profiles p WHERE p.id = p_id AND p_id = auth.uid();
$function$;
REVOKE ALL ON FUNCTION public.profile_phone(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.profile_phone(uuid) TO authenticated, service_role;

ALTER POLICY "Modifier son profil" ON public.profiles
  WITH CHECK (
    auth.uid() = id
    AND phone IS NOT DISTINCT FROM public.profile_phone(id)
  );
ALTER POLICY "Créer son profil" ON public.profiles
  WITH CHECK (auth.uid() = id AND (phone IS NULL OR phone = ''));
ALTER POLICY "users_can_insert_own_profile" ON public.profiles
  WITH CHECK (auth.uid() = id AND (phone IS NULL OR phone = ''));


-- ============================================================
-- D. RLS WITH CHECK GAPS
-- ============================================================

-- D1. market_posts "Auteur peut modifier ses posts" (v56): USING-only, so an
-- author could rewrite status (self-approve a pending/rejected post),
-- category, is_pinned, the like/comment counters or author_name. The client
-- edits only {title, content} (stores/market.ts), so every other column is
-- pinned to its old value. Moderation (status changes) goes through its own
-- paths (SECURITY DEFINER RPCs / the founder), untouched here.
ALTER POLICY "Auteur peut modifier ses posts" ON public.market_posts
  WITH CHECK (
    author_id = auth.uid()
    AND ROW(status, category, is_pinned, likes_count, comments_count, author_name)
        IS NOT DISTINCT FROM
        (SELECT ROW(mp.status, mp.category, mp.is_pinned, mp.likes_count, mp.comments_count, mp.author_name)
         FROM public.market_posts mp WHERE mp.id = market_posts.id)
  );

-- D2. chat_messages "Expediteur peut modifier ses messages" (v56): USING-only,
-- so a sender could move their message into another room (or change sender_id).
-- The client edits only {content} (stores/chat.ts). Pin room_id (and the
-- identity columns) to their old values.
-- (Same recursion trap as profiles: a subquery on chat_messages inside its own
-- policy chains through the chat_rooms SELECT policy and raises 42P17, so the old
-- identity columns are read via a STABLE definer helper that returns them only
-- for the caller's OWN messages.)
CREATE OR REPLACE FUNCTION public.chat_message_identity(p_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'room_id', cm.room_id, 'sender_id', cm.sender_id, 'sender_name', cm.sender_name,
    'created_at', cm.created_at, 'message_type', cm.message_type)
  FROM chat_messages cm
  WHERE cm.id = p_id AND cm.sender_id = auth.uid();
$function$;
REVOKE ALL ON FUNCTION public.chat_message_identity(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_message_identity(uuid) TO authenticated, service_role;

ALTER POLICY "Expediteur peut modifier ses messages" ON public.chat_messages
  WITH CHECK (
    sender_id = auth.uid()
    AND jsonb_build_object('room_id', room_id, 'sender_id', sender_id, 'sender_name', sender_name,
                           'created_at', created_at, 'message_type', message_type)
        IS NOT DISTINCT FROM public.chat_message_identity(id)
  );

-- D3. so_lines: both policies only required MEMBERSHIP of the order's business,
-- so a vendeur could read (and via the ALL policy, write) every other seller's
-- lines — while sale_orders itself isolates vendeurs to their own sales (v19)
-- and investisseurs to their product scope. Mirror sale_orders' visibility
-- EXACTLY by requiring the parent order to be visible to the caller under
-- sale_orders' own RLS (the subquery is evaluated with the caller's rights, so
-- whatever sale_orders shows — all for admin/manager, own for vendeur, scoped
-- for investisseur — is what so_lines shows). Writes keep the role limit.
DROP POLICY IF EXISTS "Voir les lignes de vente" ON public.so_lines;
CREATE POLICY "Voir les lignes de vente" ON public.so_lines FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.sale_orders so WHERE so.id = so_lines.order_id));

DROP POLICY IF EXISTS "Membres actifs: gérer les lignes de vente" ON public.so_lines;
CREATE POLICY "Membres actifs: gérer les lignes de vente" ON public.so_lines FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.sale_orders so
    WHERE so.id = so_lines.order_id
      AND get_role(so.business_id) = ANY (ARRAY['administrateur'::text, 'manager'::text, 'vendeur'::text])
  ));
