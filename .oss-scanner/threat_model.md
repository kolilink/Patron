# Threat model: Patron

## What this project does and where untrusted input enters
Patron is a multi-tenant commerce app for small shops in West Africa (sales, stock, customer credit, expenses, suppliers, team roles). It is an Expo / React Native client (TypeScript, `app/`, `stores/`, `lib/`, `src/`) on a Supabase backend: Postgres schema and ~240 SQL migrations in `db/` (`schema.sql`, `migration_v*.sql`) and Deno edge functions in `supabase/functions/`.

**Each business is a tenant.** Members hold one role per business: `administrateur`, `manager`, `vendeur`, `investisseur`. The client is untrusted. Any authenticated user can bypass the app and call PostgREST or any RPC directly with their own JWT, so server-side checks (RLS policies, `SECURITY DEFINER` function bodies, edge functions) are the only real security boundary. Client-side role hiding is defense in depth only.

Untrusted input enters through:
- Direct PostgREST table access and RPC arguments from any logged-in user (including free anonymous Supabase sessions, which the phone-OTP flow needs).
- RPC parameters that carry ids (`product_id`, `variant_id`, `client_id`, `sale_id`, `business_id`) and JSON cart/line payloads.
- Edge functions: phone/email OTP, session restore, webhooks (RevenueCat, Djomi, WhatsApp, Stripe), cron-triggered functions, push dispatch.
- Storage uploads (chat images, voice, transaction proofs).
- Offline outbox payloads: the client queues RPC calls in SQLite and replays them later.

## Components that matter most
1. **Tenant isolation.** Every business-scoped table and function must scope by `business_id` and the caller's membership/role: RLS policies, `is_member()`/`get_role()`, and every `SECURITY DEFINER` RPC (`submit_sale`, `edit_sale`, `cancel_sale`, `record_payment`, `record_client_payment`, `confirm_reception`, `receive_purchase_order`, `create_purchase_order`, `upsert_product_variants`, report RPCs, etc.). `SECURITY DEFINER` bypasses RLS, so a lookup by object id alone, without a `business_id` filter or ownership check, is a cross-tenant bug. Look at every branch (INSERT as well as UPDATE).
2. **Auth and sessions.** WhatsApp/email OTP (`create-phone-verification`, `verify-phone-code`, `restore-phone-session`, `recover-by-email`, `upgrade_anonymous_user`), invite codes and `join_business`, role changes, account deletion, biometric lock and session cache (`stores/auth.ts`, `lib/lock.ts`, `lib/encryption.ts`), function-exposure and grants (`anon`/`PUBLIC` EXECUTE), and edge functions that authenticate by shared secret or webhook header.
3. **Outbox replay and idempotency.** `lib/outbox.ts`, `lib/sync.ts`, `lib/db.ts`, `lib/pendingOverlay.ts`. A queued write may be replayed after a lost response, drained twice concurrently, or retried after a crash. Each replayable RPC (`submit_sale`, `submit_quick_sale`, `submit_carnet_debt`, `record_payment`, `record_client_payment`, `cancel_sale`, `confirm_reception`) must apply exactly once per idempotency key, including under races (concurrent calls with one key) and partial failure. Local queue state must not be forgeable into another tenant's data.
4. **Money paths.** Money is stored as BIGINT cents (x100). Sale totals, discounts, payments, FIFO debt allocation, supplier debts, cash-on-hand, profit/COGS, investor profit share, and report RPCs. Totals must be computed server-side from lines and never trusted from the client. Payments must not exceed what is owed. Stock must not change in the wrong direction (negative quantities, duplicate lines). Rounding, integer overflow, float columns and currency handling (`src/utils/format.ts`) must never produce a wrong stored or displayed amount.
5. **Role isolation inside a tenant.** A `vendeur` must not read cost prices or other sellers' sales, or use report RPCs for business-wide financials. An `investisseur` is read-only. Only admins/managers may edit sales, products, payments and stock.

## Components that matter less / out of scope
- `index.html`, `privacy.html`, `terms.html`, `support.html`, `invite/`, `abonnement/`: static marketing and landing pages. Out of scope except where they call a backend RPC/edge function.
- Physical device theft, rooted/jailbroken devices, malware on the user's phone, and shoulder surfing. The local SQLite cache is encrypted at the application layer as a best-effort measure; weaknesses in that encryption are low severity unless they expose a secret that also works against the server.
- Social engineering of WhatsApp/OTP delivery providers, and Supabase/Expo/Twilio/Resend platform vulnerabilities themselves.
- Generic DoS and rate-limit weaknesses (see severity below).
- `node_modules/`, `android/`, `dist/`, and third-party code.
- Dev-only scripts (`scripts/`) and tests, unless they leak a real secret.
- The documented reviewer demo-login bypass in `create-phone-verification` is an accepted, known risk; do not report it.

## How to exercise it
- `npx tsc --noEmit` and `npx jest` run offline and are already built into the image. `__tests__/` holds the hermetic unit suite (mocked Supabase). `__tests__/integration/` shows how each RPC is meant to be called, but cannot run in this image (no Postgres), so reason about the SQL statically.
- The effective database definition is `db/schema.sql` followed by every `db/migration_v*.sql` in numeric order. **Later migrations redefine functions: the latest definition of a function is the live one.** Check which version is current before reporting a bug in an older body.
- Edge functions are in `supabase/functions/<name>/index.ts`; shared code is in `supabase/functions/_shared/`.

## How to rate severity
- **Critical:** any RLS bypass or cross-business read/write/delete (including through a `SECURITY DEFINER` RPC taking a foreign id); any way to read or modify another tenant's sales, stock, customers, debts or payments; authentication or session bypass, account takeover, or OTP bypass (other than the accepted demo login); privilege escalation to `administrateur` or founder; any SQL injection reachable by an authenticated or anonymous caller; a server secret or service-role key exposed or usable by clients; forging a webhook or cron call that changes subscriptions or sends pushes.
- **High:** in-tenant role escalation or a vendeur/investisseur reading or writing what their role forbids (cost price, other sellers' sales, business-wide financials); any money-math error that stores or displays a wrong amount (wrong total, double-counted or lost payment, debt balance that doesn't match its ledger, overpayment accepted, negative stock quantity accepted); outbox replay or race that records a sale, payment or stock move twice, or loses one silently; a function executable by `anon`/`PUBLIC` that should require a membership; stored XSS or injection that reaches another user.
- **Medium:** information disclosure that is limited to the caller's own tenant but not intended (verbose errors, oracles that confirm whether a phone number is registered); missing rate limits on OTP or invite-code guessing where entropy is otherwise adequate; weak local-at-rest protection of cached data; pure DoS (all DoS is medium at most).
- **Low:** hardening gaps with no demonstrated exploit path.
- A money or isolation bug needs a concrete input or call sequence (SQL/RPC call, or two interleaved calls for a race) and the resulting wrong rows. Without one, cap at medium and say what is unproven.

## Reports and patches
- State the exact file and function, which migration holds the live definition, and a reproducer as an RPC/SQL call sequence or a jest test. Plain `SET LOCAL ROLE` + `request.jwt.claims` SQL is fine.
- Prefer a minimal patch as a new `db/migration_vNNN.sql` (never edit an applied migration) or a targeted TypeScript change. Don't propose sweeping refactors.

## Leave alone
- UI/UX, French copy, styling, and the hardcoded-hex or `Alert` conventions (separate lint checks).
- Accepted risks documented in `CLAUDE.md`: raw (unhashed) invite-code storage, the invite rate limiter being skippable by calling `join_business` directly (codes have ~40 bits of entropy), distinct invite-code error messages, public storage buckets (known follow-up), and the `p_client_id` cross-business inertness note.
- Dependency advisories with no reachable path from this code.
