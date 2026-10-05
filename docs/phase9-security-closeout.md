# Phase 9 — security close-out

Branch `claude/phase-9-security-closeout-uk7nvp`. Everything below was built and run on a
**throwaway local Postgres 16** (`127.0.0.1:5432/patron_test`, created for this session; no Docker or
Supabase stack is available in this sandbox). `scripts/test-db-setup.js` now refuses any non-local host
before it drops the `public` schema, and `__tests__/integration/pg.ts` already did the same for tests.
No production credential was used or available.

## What was verified, and how

| Check | Result |
|---|---|
| Clean replay from an **empty** database: `schema.sql` + all 232 migrations (incl. v231–v233) | passes (1 benign "already present") |
| `npm run check` (tsc + 72 jest suites / 817 tests + consistency checks incl. the function-exposure lint + eslint) | green (1 pre-existing eslint warning) |
| New Phase 9 integration suites (4 files, 49 tests) on the replayed DB | 49 / 49 |
| Existing PostgREST-based integration suites | **not runnable here** (need GoTrue + PostgREST). They run in `.github/workflows/integration-tests.yml` on this PR — please wait for that job before merging. |
| Deno type-check of the changed edge functions | `handler.ts`, `_shared/*.ts` against the real Deno checker; `index.ts` files against stubbed `serve`/`createClient` imports (deno.land / esm.sh are blocked from this sandbox) |

## Findings

### 1 — Phone enumeration oracle (P2) — fixed
`create-phone-verification` answered `PHONE_EXISTS` (signup) / `PHONE_NOT_FOUND` (login). Now **one path for every
number**: same 200 `{verificationId}`, same side effects (code sent, verification row written), same
call sequence, same rate limits. Deviation from the brief, deliberately: there is **no lookup at all**, not "lookup but
don't branch" — a lookup whose result is discarded buys nothing and cannot be audited as constant-time; no lookup is
strictly stronger.

Consequence the founder should know: the "this number already has an account" prompt now appears **after the OTP**
(`upgrade_anonymous_user` refusal → `PHONE_EXISTS`) and "no account for this number" after the OTP too
(`restore-phone-session` → `PHONE_NOT_FOUND`; its demo-only fallback was tightened so an unknown number can't log
into the caller's own empty anonymous profile). That reveal is gated on proving possession of the number, which is
the normal login trade-off. One more WhatsApp/SMS can now be sent to an unregistered number on a login attempt
(same cost surface as signup; 5/10 min per phone and 20/h per IP unchanged). Builds already in the field show a
generic failure at the OTP step instead of the instant prompt.

Tests (fail-before → pass-after): `__tests__/create-phone-verification-oracle.test.ts` (5 failed on the old
logic: `PHONE_EXISTS` in the body, divergent call sequence), `__tests__/phone-oracle-client.test.ts` (2 failed
before the store change), plus the DB-backed run in `phase9-adversarial` (below).

### 2 — Float money (P1) — migration + audit + founder query
See **`docs/phase9-money-columns.md`** (full replay-type table, the three read-only production queries, behaviour).
`migration_v231.sql`: exact conversion or RAISE, never rounding; no-op on the replayed schema. Facts worth knowing:
* float4 cannot represent every integer above 16,777,216, and `unit_price` is in cents → any price above
  ≈167,772 GNF could already have been rounded at write time. Conversion can't restore that; query 3 in the doc
  detects it (header total ≠ sum of lines).
* `real::numeric` keeps only 6 significant digits, so the migration converts through `double precision` (exact) or
  the shortest decimal text, never `real → numeric`.
* `so_lines.unit_price_paid` is read by v104 but **no migration creates it** — production has a column the chain
  doesn't. The migration handles it if present; the founder's query 1 will show it.
Tests: `phase9-money-types` (5 of 7 failed against an empty migration; incl. exact preservation of 150 000 000,
refusal on 1500.5, `unit_price_paid`, `12.34` not `12.3400001525879`, unknown float column aborts, and the report
RPCs on both `real` and `bigint`).

### 3 — Public storage buckets — **DECISION REQUIRED, nothing implemented**
Brief below.

### 4 — Report RPCs vs roles (P2) — fixed (4 leaks; 2 already held)
| RPC | Before | After |
|---|---|---|
| `get_reports_snapshot`, `get_period_report` | **held**: role derived from `get_role()`/`auth.uid()`, vendeur gets only `my_*`, anon revoked (v226) | unchanged; now pinned by tests per role |
| `get_best_sellers` | any member saw business-wide product revenue | vendeur → own sales; admin/manager/investisseur unchanged |
| `get_order_cogs` | any member saw business-wide COGS | admin/manager only |
| `get_dashboard_kpis` *(not on your list — found by the audit)* | vendeur's Accueil showed business-wide revenue, credits, expenses | vendeur → own sales/expenses; `first_sale_at` stays business-wide (v199 spec) |
| `get_product_stats` *(found by the audit)* | returned `capital = qty × cost` to a vendeur, who cannot read `cost_price` since v193 | vendeur refused |
| `*_unchecked` | service_role only (v228) | **re-proved**: anon and authenticated both denied; test asserts the ACL |

**Decision for you:** the brief says "administrateur/manager only", but the app itself shows **investisseur** the
whole-business profit hero (Rapports) and "bénéfice ce mois" (Accueil), and the investor dashboard computes stake
gains from `get_best_sellers`. Narrowing investisseur would break that product, so investisseur keeps the
whole-business block. If you want it narrowed, it's a one-line change per RPC, but the investor screens need a
design first.
Also: `get_stock_velocity` / `get_dashboard_kpis` / `get_product_stats` had `anon` EXECUTE (refused by `is_member`
inside) — revoked at the privilege layer too.
Tests: `phase9-report-role-gates` (4 of the 19 assertions failed on the old functions → 19/19).

### 5 — search_path (P2) — fixed, with a correction to the brief
Enumerated programmatically: **19** functions had no search_path on the replayed schema — 8 SECURITY DEFINER (your 5,
plus **`update_chat_message_edited_at` / `update_market_post_edited_at`, which are SECURITY DEFINER, not invoker as the
brief said**, plus the stale service_role-only `receive_purchase_order(uuid,uuid,uuid)`) and 11 invoker (your 10, plus
`set_updated_at`). Pinned
`public, pg_temp` — not plain `'public'`: Postgres searches the caller's `pg_temp` **first** unless it is named, so
`public` alone is still shadowable (proved below). Logic untouched (`ALTER FUNCTION … SET`, every body read; all
cross-schema references are qualified or `pg_catalog`).
**Open follow-up:** 139 older SECURITY DEFINER functions (+3 invoker) pin `public` without `pg_temp`, including the
money RPCs. Same one-line ALTER each, but I could not run the full PostgREST suite here, so I did not touch them.
**Extra finding while enumerating:** the legacy 4-arg `create_market_post` / `create_market_comment`
(caller-supplied `author_name`) were still executable by `authenticated` and `anon` — v44's `REVOKE … FROM authenticated`
never touched the PUBLIC/anon grants — so any signed-in user (an "administrateur" of a throwaway business skips the
level gate) could post with a forged name and no rate limit / first-post approval. REVOKEd in v233; the app only
uses the 3-arg signatures.

### 6 — RevenueCat timing oracle (P3) — fixed
`_shared/webhook-auth.ts` (`bearerMatches`, constant-time over the full max length, fails closed on an unset
secret); behaviour otherwise identical. Deploy with `--no-verify-jwt` as always (static-header auth).

### 7 — Adversarial re-verification (test stack only) — what held
* **Phone enumeration** (`phase9-adversarial` A): 20 registered + 20 unknown numbers × signup/login through the real
  handler against the real tables: all 80 responses `200 {verificationId}`, no existence marker anywhere, a
  verification row written for every number, per-group mean latency indistinguishable (difference < 2σ of the
  per-request noise). A verified signup on a taken number is refused with the same generic `Accès refusé` whether
  or not the attacker proved possession.
* **Report / unchecked RPCs** (B): 7 functions × {anon, non-member, vendeur}: nothing leaked; vendeur gets
  `role: vendeur` with every business-wide field 0. service_role still works.
* **Forged webhooks** — executed the *real* `revenuecat-webhook/index.ts` and `djomi-webhook/index.ts` under Deno
  (stubbed `serve`; any DB/auth access before the gate throws): 7 forged RevenueCat headers (none, empty, wrong,
  no scheme, prefix, suffix, lower-case scheme) and 8 forged Djomi signatures (none, malformed, wrong version, empty
  hex, wrong key, other body, truncated, upper-case) all → 401 with **no DB access**; correct credentials pass the
  gate; non-POST → 405. (Harness is not committed: it depends on local stubs.)
* **search_path hijack** (C): for each of the five functions an attacker's shadow table **succeeds against an
  unpinned copy** (so the test has teeth) and **fails against the migrated function**: self-like via shadow
  `market_posts`, self-like via shadow `market_comments`, level-1 user posts via shadow `profiles.community_level`,
  identity spoof via shadow `profiles.pseudo`, new business left without its "Ma Boutique" room via shadow
  `chat_rooms`. (The attacker's temp table is created before the role switch so the test doesn't depend on a stack
  granting TEMP to `authenticated`.)

**What I could not verify here:** the existing PostgREST suites; the edge functions' `index.ts` against real
`esm.sh` types; production data (the money pre-flight must be run by you); WhatsApp/Twilio delivery.

## Finding 3 — decision brief: public vs private storage buckets

**Situation.** `message-images` (chat + support photos), `voice-messages`, `transaction-proofs` are `public = true`.
The DB stores the **permanent public URL** (`chat_messages.image_url` / `voice_url`, `support_messages.image_url`,
`expenses|capital_injections|purchase_orders.proof_image_url`). Anyone holding a URL downloads the file with no
auth, forever; v228's object policies only gate list/upload/overwrite/delete, never a download by URL (verified on
the local stack; pinned by the KNOWN LIMITATION test in `security-batch-v228-storage`). Paths contain uuids, so this
is "unguessable but unrevocable", not "open": the realistic exposures are a URL leaked via a forwarded message,
screenshot, log or analytics event, and **a removed member keeping access to everything they ever saw**. Payment
proofs (receipts, mobile-money screenshots with names/numbers) are the most sensitive content.

**Option A — stay public.** Zero work, nothing breaks, images load instantly and cache by URL. Keep the uuid paths,
never log URLs, accept unrevocable links. Defensible only if you judge receipts low-sensitivity.

**Option B — private buckets + signed URLs (recommended, staged).** What changes:
1. *DB:* `UPDATE storage.buckets SET public = false` per bucket. **Policies must be tightened first**, otherwise
   "private" only means "any signed-in user who knows a uuid": `message_image_allowed('chat/…')` today only checks that
   the room exists and is not global — **not that the caller is in it**; `voice read` is scoped to the *uploader's*
   business, so a **partner-DM recipient from the other business could not read a voice note** once signing goes
   through their own session (needs a room/partnership-based policy, or server-side signing). `transaction-proofs`
   already scopes by `is_member(business_id)` — correct as is.
2. *Stored value:* new rows should store the **storage path**, not the URL; a one-off backfill rewrites existing
   `…/object/public/<bucket>/<path>` to `<path>` (pure SQL).
3. *Client render paths that change* (all currently use the stored URL directly):
   `ImageMessageBubble` (boutique chat, partner DMs `messages/[room_id].tsx`), `SupportMessageBubble` (support chat),
   `VoiceMessageBubble` (expo-av `createAsync({uri})`), `ProofControl` (PO detail `fournisseurs/[id]`, expense card
   `depenses`), `ProofThumbnail` + `ProofPhotoField` (`apports`, `depenses` form). Upload paths are unchanged
   (they already write by path); `getPublicUrl()` calls in `lib/chatImages.ts`, `stores/chat.ts`,
   `messages/[room_id].tsx` stop being used.
4. *New client piece:* `lib/signedUrls.ts` — batch `createSignedUrls` (≤100 paths/call), in-memory TTL cache
   (sign for ~1 h, re-sign at 80 %), used by those 6 components; list screens sign the visible page in one call.
5. *Offline / caching:* signing needs the network. `expo-image` caches by URL, and a signed URL changes per signing,
   so pass `source={{ uri, cacheKey: path }}` to keep previously viewed images available offline (today they are
   available the same way). An image never opened before and viewed offline fails exactly as now.
6. *What breaks:* any build that renders `image_url` directly shows broken images once a bucket flips. The client
   change is JS-only (OTA reaches builds on the current native fingerprint); older native builds will break until
   updated → **ship the dual-mode client first (accepts a path or a legacy URL), wait for adoption, then flip.**
   Rollback is one `UPDATE … SET public = true`.
7. *Not affected:* push notifications (lock-screen rule already forbids media), receipt PNG sharing (generated
   locally), Alpha/edge functions (none read these buckets).

**Effort.** `transaction-proofs` alone: ~1–1.5 days (3 components + signing helper + flip; policy already right).
Chat + support images + voice with the policy fixes, backfill and the partner-DM case: ~3–4 days incl. QA on iOS and
Android. Total ≈ 4–5 dev-days, plus one OTA and a two-week adoption window before the flip.

**Recommendation.** Do Option B, **proofs first** (highest sensitivity, smallest surface, policy already correct,
always viewed online), then chat/support/voice after the room-membership and partner-DM policy fixes. If B is not
funded now, at least fix the chat-image read policy so a non-member can't read by uuid — it's a prerequisite either way.

## Open items / needs the founder
1. **Run the three production queries** in `docs/phase9-money-columns.md` and send the output *before* applying
   `migration_v231.sql` (it refuses on fractional values by design).
2. **Decide Finding 3** (recommendation above).
3. **Investisseur scope** on report RPCs (kept whole-business because the app shows it to them).
4. **139 + 3 older functions** still pin `public` without `pg_temp` — approve a follow-up sweep once the PostgREST
   suite is green on this branch.
5. Apply order: pre-flight → v231 → v232 → v233; deploy `create-phone-verification`, `restore-phone-session`
   (normal) and `revenuecat-webhook` with `--no-verify-jwt`, then smoke-test each with a real call.
