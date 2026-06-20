# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Expo has changed significantly.** Always read the versioned docs at https://docs.expo.dev/versions/v54.0.0/ before writing Expo-specific code.

## Project

**Patron** is a React Native (Expo Router v6) mobile commerce management app targeting small businesses in West Africa. UI and all labels are in French. Supports multiple currencies per business. Designed for iOS and Android (no web PWA target).

## Commands

```bash
# Dev server
npx expo start
npx expo start --ios
npx expo start --android

# Type-check (no test suite, no linter)
npx tsc --noEmit

# OTA update (JS-only changes — no native rebuild needed)
npx eas update --channel production --message "description"

# EAS build + submit to App Store / Play Store
eas build --platform ios --profile production
eas build --platform android --profile production
eas submit --platform ios --profile production
eas submit --platform android --profile production
```

No test suite. No linting config.

## Architecture

### Routing (Expo Router v6 file-based)

```
app/
  _layout.tsx           — Root layout: initializes auth + SQLite, hides splash
  index.tsx             — Redirects to (welcome) or (app) based on session
  (welcome)/            — Unauthenticated: index, connexion, creer, rejoindre
  (app)/
    _layout.tsx         — Guards: redirects to /(welcome)/ if no session. Mounts SyncBanner + AppLockOverlay
    (tabs)/             — Bottom tabs: Accueil, Catalogue, Vendre, Plus
    onboarding/         — Create or join a business after first login
    ventes/             — Sales history + detail
    depenses/           — Expense management
    equipe/             — Team management
    fournisseurs/       — Supplier list + detail ([id].tsx)
    clients/            — Customer list + ledger ([name].tsx)
    credits/            — Credit tracking
    rapports/           — Reports
    parametres/         — Settings, leave business, delete account, privacy links
    discussions.tsx     — Boutique private chat room
    marche/             — Le Marché community forum (index + [id].tsx post detail)
```

`investisseur` role sees only the Accueil and Plus tabs — Catalogue and Vendre use `href: null` to hide them. Investisseurs have **read-only** access to sale_orders, expenses, and products (added v38).

### Auth flow

`stores/auth.ts` (`useAuthStore`) is a Zustand store initialized in the root `_layout.tsx` via `initialize()`. It calls `supabase.auth.getSession()` and loads the user's profile + memberships into `AppSession`. If the user has exactly one business it auto-selects it; otherwise `(app)/onboarding` prompts selection. The `(app)/_layout.tsx` redirects to `/(welcome)/` when no session.

Authentication is **WhatsApp OTP only** — no email/password. Flow: anonymous Supabase session → `create-phone-verification` Edge Function (sends 6-digit code via WhatsApp Twilio, returns only `verificationId`) → user types code in-app via `OtpInput` → `verify-phone-code` Edge Function verifies code and marks row `verifie` → for login: `restore-phone-session` generates magic link → client calls `verifyOtp`; for register: `upgradePhone` sets profile phone + lifts anonymous flag.

iOS AutoFill: `textContentType="oneTimeCode"` on the hidden `OtpInput` TextInput causes iOS to suggest the OTP from recent WhatsApp notifications above the keyboard.

Creating a business generates the UUID client-side first, then inserts — this avoids an RLS race where `SELECT` after `INSERT ... RETURNING` fires before the `handle_business_created` trigger creates the membership row.

Joining a business uses invite codes (`equipe` store generates/revokes them) via the `join_business()` SECURITY DEFINER RPC — this is the **only** way to insert a membership row (the open INSERT policy was dropped in v43). Invite code generation uses `Math.random()` — **do not use `crypto.getRandomValues()`**, it is not available in Hermes (React Native's JS engine).

### App Store review demo account

`supabase/functions/create-phone-verification/index.ts` checks for a `DEMO_PHONE` environment variable (set in Supabase Edge Function secrets). If the phone matches, the row is inserted with token `000000` and status `en_attente` — no WhatsApp message is sent. The reviewer enters `000000` in the OTP input to proceed. This lets Apple reviewers log in without WhatsApp access. The `DEMO_PHONE` value is `+15555555555`.

### App lock overlay (`src/components/AppLockOverlay.tsx`)

Wraps the entire `(app)` navigator. Manages a `LockState: 'clear' | 'blurred' | 'auth'` state machine:
- **30 seconds** no touch → `blurred` (BlurView intensity 72, tap anywhere to clear)
- **2 minutes** backgrounded → `auth` (BlurView intensity 92 + biometric prompt)
- Uses `lockRef` alongside React state to avoid stale closures in AppState callbacks
- `triggerBiometric` fails open (grants access) if device has no biometric enrolled
- Auto-triggers biometric when entering `auth` state and on every foreground return while locked

### Monetary amounts — BIGINT cents (×100)

**All monetary columns in the DB are stored as BIGINT integer cents (×100).** 1500 GNF is stored as 150000. This was applied in v24 to eliminate floating-point precision errors.

- Always multiply by 100 before writing to DB; divide by 100 before display.
- Use `formatAmount(n, currency)` from `src/utils/format.ts` to display — it handles whole-unit currencies (GNF, XOF) vs decimal currencies automatically.
- This applies to: `products.sale_price`, `products.cost_price`, `products.bulk_price`, `sale_orders.total_amount`, `sale_orders.discount_amount`, `so_lines.unit_price`, `payments.amount`, `expenses.amount`, `supplier_debts.amount`.

### Two sales stores — important distinction

There are **two separate stores** for sales:

| Store | File | Purpose |
|---|---|---|
| `useSalesStore` | `stores/sales.ts` | Point-of-sale cart: add/remove items, set quantities, bulk pricing toggle, submit checkout (calls `submit_sale` RPC) |
| `useVentesStore` | `stores/ventes.ts` | Sales history: fetch list, detail modal, cancel sale (restores stock), mark credit as paid, update customer name |

Do not conflate them. The POS flow lives entirely in `sales.ts`; post-sale mutations live in `ventes.ts`.

### Store pattern (Zustand, `stores/`)

All domain stores use Zustand with direct Supabase calls — no local write-through cache. Stores hold arrays of fetched records and expose `loading`/`saving` flags. Call each store's `reset()` on logout (handled in `useAuthStore.logout()`).

Stores: `auth`, `chat`, `clients`, `equipe`, `expenses`, `fournisseurs`, `market`, `products`, `rapports`, `sales` (POS), `sync`, `toast`, `ventes` (history).

`useRapportsStore` (`stores/rapports.ts`) — fetches the last 180 days of payments + COGS from `so_lines` for the reports screen. Called from the dashboard on every focus via `fetchPaymentsAndCogs(businessId)`.

`useToastStore` (`stores/toast.ts`) — global in-app toast notifications. Use the `toast` helper (not the store directly): `toast.success(msg)`, `toast.warning(msg)`, `toast.info(msg)`. Mount `<AppToastContainer />` once at the app root; it renders the animated banner automatically.

### Chat system (`stores/chat.ts`)

Dual-mode chat with two room types:

| Room | Key | Notes |
|---|---|---|
| Boutique | `boutiqueRoom` | Private per-business room; members only |
| Le Marché | `globalRoom` | Global room (`GLOBAL_ROOM_ID` constant), all users |

`load(businessId, currentUserId)` fetches both rooms and recent messages, then computes `boutiqueUnread` and `marcheUnread`. The boutique last-read timestamp is stored in the `chat_room_reads` DB table (REPLICA IDENTITY FULL for real-time); the marché last-read is stored locally via `getKV(MARCHE_KEY)`.

**Business-switching bug (known):** The guard in `(app)/_layout.tsx` is `if (!bId || !uId || boutiqueRoom !== null) return;`. When the user switches businesses without logging out, `boutiqueRoom` still holds the old value and `loadChat` is never called for the new business — the unread count stays stale. Only a full logout+login resets it cleanly.

`appendMessage` is called from the real-time subscription to push new messages without a full re-fetch.

### Le Marché community forum (`stores/market.ts`)

`market_posts`, `market_comments`, `post_likes`, `comment_likes` tables (v37–v40). Posts and comments are gated by `community_level`:
- `community_level` is auto-computed from `profiles.points` via a DB trigger
- Posting requires `community_level >= 2`; admins bypass this
- `administrateur` members always bypass the level gate
- Like velocity cap: max 3 likes/day per unique (liker, post/comment) pair (v40)
- `author_name` is derived server-side from `profiles` — the `create_market_post` and `create_market_comment` RPCs ignore any caller-supplied name (v44)

### Error handling (`lib/errors.ts`)

Always wrap Supabase errors with `translateError(error)` before displaying to users. It maps Supabase/Postgres error codes and messages to French strings. Never show raw Supabase error messages in the UI. Postgres exceptions raised in RPCs with French messages pass through untranslated (used for `join_business` rate-limit, manager-limit, and expired-code messages).

### Forms

Forms use `react-hook-form` + `zod`. Define a Zod schema, derive the TypeScript type with `z.infer<>`, pass the resolver to `useForm`. Validation error messages should be in French.

### Offline queue (`lib/db.ts` + `lib/sync.ts` + `stores/sync.ts`)

`expo-sqlite` opens `patron.db` with WAL mode on first call (`openDb()`). A `migrate()` function tracks versions in `_migrations`.

**Offline write flow:**
1. Store attempts the Supabase call normally.
2. On network error (`isNetworkError()` in `lib/sync.ts`), the payload is written to the `sync_queue` SQLite table via `enqueue()`.
3. `app/(app)/_layout.tsx` listens to `AppState` changes and calls `drainQueue()` every time the app comes to foreground. If any items sync successfully, products are re-fetched.
4. `useSyncStore` (`stores/sync.ts`) exposes `pendingCount`, `syncing`, and `sync()`. `SyncBanner` in `_layout.tsx` renders an amber strip when `pendingCount > 0`.
5. Failed items are retried up to `MAX_SYNC_ATTEMPTS = 5` times, then excluded from the count.

Operations queued: `submit_sale` (RPC) and `create_expense` (table insert).

`stores/sales.ts` exposes `lastSubmitQueued: boolean` so `vendre.tsx` can show "Vente enregistrée hors ligne ⏳" and skip the `fetchProducts` call (which would also fail offline).

**Web stub:** `lib/db.web.ts` exports no-op stubs for all queue helpers so the app bundles on web without crashing.

### SQLite cache encryption (`lib/encryption.ts`)

AES-256-GCM application-layer encryption for any sensitive SQLite data. Key is generated once per install and stored in `expo-secure-store` (hardware-backed). Uses `globalThis.crypto.subtle` (Hermes built-in WebCrypto, available in RN 0.76+ / Expo SDK 54+) — not `expo-crypto`, which does not expose `subtle`. The sync queue itself is intentionally left unencrypted (it's transient).

### Receipt sharing (`src/components/ui/SaleReceiptView.tsx`)

A pure presentation component that renders a branded PNG receipt. Captured via `react-native-view-shot` (`captureRef`) and shared via `expo-sharing` (`Sharing.shareAsync`).

**Critical rendering constraint:** `captureRef` requires the target view to be within the GPU compositor bounds. Off-screen placement (`top: -9999`, `top: 5000`) returns a blank image. The pattern used: receipt at `top: 0, left: 0` inside a Modal → solid white `StyleSheet.absoluteFill` cover hides it from the user → dark overlay Pressable on top. `captureRef` captures the receipt's own pixels, unaffected by overlapping views.

**Share timing:** Call `Sharing.shareAsync` only after the modal close animation completes — use `await new Promise(r => setTimeout(r, 350))` between `setShowConfirmSheet(false)` and the share call. On Android, keeping the modal open during sharing causes both to dismiss if the user backgrounds the app.

### Parametres screen (`app/(app)/parametres/index.tsx`)

Contains three critical flows:
- **Leave business** — checks remaining memberships after deletion. If others exist, auto-switches to the first one and stays in the app. If none remain, redirects to `/(welcome)/` directly (not via onboarding).
- **Delete account** — calls `delete_my_account()` RPC. Blocked if user is admin of a business with other active members. User must type `SUPPRIMER` to confirm.
- **Privacy + support links** — "Politique de confidentialité" opens `https://patron.kolilink.com/privacy.html`; "Contacter le support" opens `https://wa.me/16094454809`.

### Theme (`src/theme/`)

`src/theme/ThemeContext.tsx` provides a `ThemeProvider` (mounted in root `_layout.tsx`) and the `useTheme()` hook. The hook returns `{ palette, colorScheme, resolvedScheme, setColorScheme }`. User preference (`light | dark | system`) is persisted via `getKV/setKV`.

Always get `palette` via `useTheme()` — never import `paletteLight` or `paletteDark` directly in screens. Import spacing/radius/typography from `@/src/theme`.

Primary color is indigo (`#6366F1` / `colors.primary[500]`). Role colors: administrateur=indigo, manager=cyan, vendeur=green, investisseur=amber.

**Never use hardcoded hex values in screens** — always reference `palette` tokens.

### UI components (`src/components/ui/`)

Use the shared components before building ad-hoc ones. Import via `@/src/components/ui`.

| Component | Notes |
|---|---|
| `Button` | Primary/secondary/ghost variants, size sm/md/lg, fullWidth |
| `Card` | Surface container with border + shadow; pass `onPress` to make it tappable |
| `Text` | Semantic variants: h1–h4, body, bodySmall, label, caption, amount, amountLarge — map to `typography` tokens. **`amountLarge` has `lineHeight: 40` baked in — always override with a larger `lineHeight` when using a larger `fontSize`.** |
| `Input` / `DatePickerField` / `PhoneInput` | Form primitives |
| `AppSheet` | Animated bottom sheet (spring in/out). Props: `visible`, `onClose`, `title`, `body`, `icon?`, `action?`. |
| `AppToast` / `AppToastContainer` | Top-banner toast; use `toast.success/warning/info()` helper from `stores/toast.ts`, not the component directly |
| `OtpInput` | 6-digit OTP entry with iOS AutoFill (`textContentType="oneTimeCode"`) |
| `SkeletonPlaceholder` / `SkeletonKpiGrid` | Loading skeletons for the dashboard KPI grid |
| `SaleReceiptView` | PNG receipt capture + share (see critical rendering constraint in architecture notes) |
| `SaleSuccessOverlay` | Post-sale confirmation with receipt action |

### Types (`src/types/index.ts`)

All domain types live here. Key ones:
- `Role`: `administrateur | manager | vendeur | investisseur`
- `OrderStatus`: `brouillon | confirme | annule | paye | credit`
- `AppSession`: `{ user, activeBusiness, activeMembership, memberships }`
- `Business`: multi-tenant entity with per-business `currency` field
- `User.recovery_email`: nullable — loaded from `profiles.recovery_email` in `loadSession`

### DB schema & migrations

Run Supabase migrations in order in the SQL Editor. Never skip versions.

| File | What it adds |
|------|-------------|
| `db/schema.sql` | Base schema; `is_member(business_id)` + `get_role(business_id)` RLS helpers; triggers for auto-profile + auto-admin-membership |
| `db/migration_v2.sql` – `v3.sql` | Incremental changes |
| `db/migration_v4.sql` | `clients` table, cancellation fields + reason tracking on `sale_orders` |
| `db/migration_v5.sql` | `payments` gets `date`, `customer_name`, `business_id` columns |
| `db/migration_v6.sql` | `sale_orders` gets `is_credit` boolean flag |
| `db/migration_v7.sql` | `sale_orders` gets `discount_amount`; payments `method` constraint updated |
| `db/migration_v8.sql` – `v18.sql` | Incremental feature additions |
| `db/migration_v19.sql` | RLS: split sale_orders + expenses SELECT into vendeur-only vs admin/manager policies |
| `db/migration_v20.sql` | Fix: drops the old catch-all "Membres: voir les ventes" policy missed by v19 |
| `db/migration_v21.sql` | `invite_attempts` rate-limit table; `validate_invite_code()` SECURITY DEFINER RPC (5 attempts/10 min); admin/manager-only UPDATE on memberships |
| `db/migration_v22.sql` | `get_best_sellers()` RPC; `submit_sale()` + `cancel_sale()` SECURITY DEFINER RPCs; removes vendeur INSERT access on `stock_moves` |
| `db/migration_v23.sql` | `delete_my_account()` SECURITY DEFINER RPC |
| `db/migration_v24.sql` | **All monetary columns → BIGINT cents (×100)** across products, sale_orders, so_lines, payments |
| `db/migration_v25.sql` | `analytics_events` table — founder analytics (INSERT only for merchants; read via service role) |
| `db/migration_v26.sql` | `sale_orders.idempotency_key` UUID column + partial unique index |
| `db/migration_v27.sql` | `phone_verification_attempts` rate-limit table (used by Edge Function) |
| `db/migration_v28.sql` | Fix: restrict product writes to admin/manager only (removes vendeur DB-level access) |
| `db/migration_v29.sql` | Enforce 1 business created per user via RLS policy |
| `db/migration_v30.sql` | Fix: vendeur expenses INSERT locked to `status='en_attente'` only |
| `db/migration_v31.sql` | Enforce max 1 manager per business via memberships INSERT policy |
| `db/migration_v32.sql` | Fix: infinite RLS recursion in memberships INSERT — extracted to `count_joined_businesses()` + `has_manager()` SECURITY DEFINER helpers |
| `db/migration_v33.sql` | `chat_rooms` + `chat_messages` tables; boutique private rooms + global Le Marché room |
| `db/migration_v34.sql` | `chat_room_reads` table — per-user read cursors for unread count |
| `db/migration_v35.sql` | `REPLICA IDENTITY FULL` on `chat_room_reads` so real-time UPDATE events carry payload |
| `db/migration_v36.sql` | `receive_purchase_order()` RPC — atomic stock update on PO receipt |
| `db/migration_v37.sql` | Le Marché: `market_posts`, `market_comments`, `post_likes`; `profiles.points`; `create_market_post` + `create_market_comment` + `toggle_post_like` RPCs |
| `db/migration_v38.sql` | RLS: investisseurs get SELECT on sale_orders, expenses, products |
| `db/migration_v39.sql` | `comment_likes` table; `toggle_comment_like` RPC; posting open to all authenticated members |
| `db/migration_v40.sql` | `profiles.community_level`; 9-tier level ladder; `create_market_post` gated on `community_level >= 2`; 3-likes/day velocity cap |
| `db/migration_v41.sql` | `supplier_debts` table — tracks what business owes each supplier (BIGINT cents) |
| `db/migration_v42.sql` | `sale_orders.client_id` FK to clients; backfill by name match; `submit_sale` updated to accept `p_client_id` |
| `db/migration_v43.sql` | `join_business()` SECURITY DEFINER RPC — now the only way to insert a membership (drops the open INSERT policy) |
| `db/migration_v44.sql` | Fix: `author_name` in `create_market_post` / `create_market_comment` derived from DB, not caller-supplied |
| `db/migration_v45.sql` | Fix: `receive_purchase_order` adds admin/manager role gate; uses `auth.uid()` instead of caller-supplied `p_user_id` |
| `db/migration_v46.sql` | Fix: `join_business` returns specific error messages for expired vs used vs invalid codes (instead of generic NULL) |
| `db/migration_v47.sql` | `businesses` gets `subscription_status` (trialing/active/cancelled/expired), `trial_ends_at`, `stripe_customer_id` |
| `db/migration_v48.sql` | `receive_purchase_order` auto-updates `products.cost_price` from PO unit cost on receipt |
| `db/migration_v49.sql` | Partial receipt support: `p_line_ids` param; PO status → `recu_partiel` when some lines remain |
| `db/migration_v50.sql` | Per-line received quantities (`p_line_ids` / `p_line_qtys` parallel arrays); `qty_received` is additive |
| `db/migration_v51.sql` | Fix: `submit_sale` stock deduction now rolls back the whole sale on failure (was silently swallowed); sole-admin cannot leave their own business |
| `db/migration_v52.sql` | Fix: `submit_sale` idempotency race — catches `unique_violation` (23505) and returns existing order instead of error |
| `db/migration_v53.sql` | Fix: `join_business` no longer burns rate-limit on non-existent codes |
| `db/migration_v54.sql` | Fix: adds `so_lines.product_name` column (missing since v51); reverts non-credit sale status back to `paye` (v51 had incorrectly set `confirme`) |
| `db/migration_v55.sql` | Chat reply threading: `chat_messages` gets `reply_to_id`, `reply_to_content`, `reply_to_sender_name` (denormalised — no JOIN needed to render reply preview) |
| `db/migration_v56.sql` | Message + post editing: `chat_messages` and `market_posts`/`market_comments` get `edited_at` timestamp |
| `db/migration_v57.sql` | `sale_orders.due_date` (DATE) — optional payment deadline for credit sales |
| `db/migration_v76.sql` | Email account recovery: `profiles.recovery_email` (UNIQUE TEXT); `email_verifications` + `email_verification_attempts` tables (service-role only, no user RLS policies) |

`discount_amount` convention: `total_amount` always stores catalog total; `discount_amount + amount_paid = total_amount` for a closed discounted sale.

`lib/db.ts` — SQLite local migrations (auto-run on app start, versioned in `_migrations` table). Current schema version: 7 (sync_queue).

### Security & role isolation

Four roles: `administrateur`, `manager`, `vendeur`, `investisseur`.

**RLS is the primary gate.** All writes that vendeurs can trigger go through SECURITY DEFINER RPCs (never direct table INSERT):
- `submit_sale(...)` — creates sale_order + so_lines + payment + stock_moves atomically. Enforces that a vendeur can only submit sales in their own name. Accepts optional `p_client_id` and `p_idempotency_key`.
- `cancel_sale(p_sale_id, p_business_id, p_reason)` — marks annulé, restores stock. Vendeurs can only cancel their own sales.
- `join_business(p_code)` — validates invite code, enforces rate limit (5/10 min), expiry, max_uses, manager limit, join limit (3 non-admin memberships), then inserts membership atomically. Raises specific French exceptions for each failure mode.
- `get_best_sellers(p_business_id, p_month_start, p_limit)` — server-side aggregation.
- `delete_my_account()` — safe self-deletion with admin guard.
- `receive_purchase_order(p_po_id, p_business_id)` — admin/manager only; uses `auth.uid()` for audit trail.
- `create_market_post(p_title, p_content, p_category)` — derives author_name from profiles server-side.
- `create_market_comment(p_post_id, p_parent_id, p_content)` — same.
- `toggle_post_like` / `toggle_comment_like` — enforce 3-likes/day velocity cap.

**Frontend is defense-in-depth** (not the primary control):
- Catalogue + Vendre tabs hidden for investisseur (`href: null` in tabs layout).
- `fetchSales` passes `sellerId` filter for vendeurs so they only see their own sales.
- `ventes/index.tsx` defaults to a 90-day window; "Voir tout l'historique" toggle re-fetches without the date filter.

### Email account recovery

`profiles.recovery_email` (TEXT UNIQUE, nullable) — set proactively by the user in Paramètres as a fallback if they lose their phone number.

**Linking flow (in-app, authenticated):** Paramètres → "Email de récupération" → enter email → `send-email-otp` sends 6-digit code via Resend → user enters code → `link-recovery-email` validates + saves to profile.

**Recovery flow (unauthenticated, on login screen):** "Numéro indisponible ?" → `/(welcome)/recuperation` → same email OTP → `recover-by-email` finds profile by `recovery_email`, generates magic link → `supabase.auth.verifyOtp({ token_hash, type: 'magiclink' })` → session. Identical magic-link pattern to `restore-phone-session`.

**OTP validation pattern in edge functions:** Always fetch the `email_verifications` row by `id` alone first (no status/expiry filters in the query), then check each condition separately with a distinct error message. Combining all filters into one query silently returns null for any failure reason, making debugging impossible.

### Critical: auth store `loading` flag

`(app)/_layout.tsx` renders `null` when `loading === true` — this unmounts the entire navigator, causing a white screen and redirect to `/(welcome)/`. **Never set `loading: true` from a store method called while the user is already inside the app.** 

Auth store has a separate `emailOtpLoading: boolean` flag for email OTP operations (`sendEmailOtp`, `linkRecoveryEmail`). Any future in-app async operations that need a loading state must use their own flag — not the global `loading`. The global `loading` is only for the initial session bootstrap.

### Supabase client (`lib/supabase.ts`)

Uses `expo-secure-store` for session storage with custom 2 KB chunking (SecureStore has a per-key size limit, so tokens are split across multiple keys). The `@/` alias maps to the project root (configured in `tsconfig.json`).

`lib/supabase.web.ts` is a stub for the web bundle (no-op — the app has no real web target).

### Edge Functions (`supabase/functions/`)

| Function | Purpose |
|---|---|
| `create-phone-verification` | Creates OTP row, sends WhatsApp via Twilio. Bypasses for `DEMO_PHONE` env var (App Store review). Rate-limited via `phone_verification_attempts`. |
| `whatsapp-inbound-webhook` | Marks verification row as `verifie` when user sends token back via WhatsApp |
| `restore-phone-session` | Generates magic link for verified phone, returns `token_hash` for `verifyOtp` |
| `send-whatsapp-otp` | Twilio WhatsApp message dispatch |
| `verify-phone-code` | Verifies 6-digit code entered in-app against `phone_verifications` row; marks `verifie` on match |
| `verify-phone-otp` | OTP verification helper |
| `send-email-otp` | Sends 6-digit recovery code via Resend (`noreply@patron.kolilink.com`). No auth required — user may be locked out. Rate-limited via `email_verification_attempts`. |
| `link-recovery-email` | Validates email OTP then links `recovery_email` to authenticated user's profile. Rejects if email already taken by another account. |
| `recover-by-email` | Validates email OTP, finds profile by `recovery_email`, generates magic link session. No auth required. |
