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
    fournisseurs/       — Supplier management
    clients/            — Customer list
    credits/            — Credit tracking
    rapports/           — Reports
    parametres/         — Settings, leave business, delete account, privacy links
```

`investisseur` role sees only the Accueil and Plus tabs — Catalogue and Vendre use `href: null` to hide them.

### Auth flow

`stores/auth.ts` (`useAuthStore`) is a Zustand store initialized in the root `_layout.tsx` via `initialize()`. It calls `supabase.auth.getSession()` and loads the user's profile + memberships into `AppSession`. If the user has exactly one business it auto-selects it; otherwise `(app)/onboarding` prompts selection. The `(app)/_layout.tsx` redirects to `/(welcome)/` when no session.

Authentication is **WhatsApp OTP only** — no email/password. Flow: anonymous Supabase session → `create-phone-verification` Edge Function → user sends token via WhatsApp → `whatsapp-inbound-webhook` marks verification as `verifie` → `restore-phone-session` Edge Function generates a magic link → client calls `verifyOtp`.

Creating a business generates the UUID client-side first, then inserts — this avoids an RLS race where `SELECT` after `INSERT ... RETURNING` fires before the `handle_business_created` trigger creates the membership row.

Joining a business uses invite codes (`equipe` store generates/revokes them). Invite code generation uses `Math.random()` — **do not use `crypto.getRandomValues()`**, it is not available in Hermes (React Native's JS engine).

### App Store review demo account

`supabase/functions/create-phone-verification/index.ts` checks for a `DEMO_PHONE` environment variable (set in Supabase Edge Function secrets). If the phone matches, the verification row is inserted already-verified with a fixed token `PATRON-000000` — no WhatsApp message is sent. This lets Apple reviewers log in without WhatsApp access. The `DEMO_PHONE` value is `+10000000000`.

### App lock overlay (`src/components/AppLockOverlay.tsx`)

Wraps the entire `(app)` navigator. Manages a `LockState: 'clear' | 'blurred' | 'auth'` state machine:
- **30 seconds** no touch → `blurred` (BlurView intensity 72, tap anywhere to clear)
- **2 minutes** backgrounded → `auth` (BlurView intensity 92 + biometric prompt)
- Uses `lockRef` alongside React state to avoid stale closures in AppState callbacks
- `triggerBiometric` fails open (grants access) if device has no biometric enrolled
- Auto-triggers biometric when entering `auth` state and on every foreground return while locked

### Two sales stores — important distinction

There are **two separate stores** for sales:

| Store | File | Purpose |
|---|---|---|
| `useSalesStore` | `stores/sales.ts` | Point-of-sale cart: add/remove items, set quantities, bulk pricing toggle, submit checkout (creates `sale_order` + `so_lines` + `payment` + `stock_moves`) |
| `useVentesStore` | `stores/ventes.ts` | Sales history: fetch list, detail modal, cancel sale (restores stock), mark credit as paid, update customer name |

Do not conflate them. The POS flow lives entirely in `sales.ts`; post-sale mutations live in `ventes.ts`.

### Store pattern (Zustand, `stores/`)

All domain stores use Zustand with direct Supabase calls — no local write-through cache. Stores hold arrays of fetched records and expose `loading`/`saving` flags. Call each store's `reset()` on logout (handled in `useAuthStore.logout()`).

Stores: `auth`, `clients`, `equipe`, `expenses`, `fournisseurs`, `products`, `sales` (POS), `sync`, `ventes` (history).

### Error handling (`lib/errors.ts`)

Always wrap Supabase errors with `translateError(error)` before displaying to users. It maps Supabase/Postgres error codes and messages to French strings. Never show raw Supabase error messages in the UI.

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

### Parametres screen (`app/(app)/parametres/index.tsx`)

Contains three critical flows:
- **Leave business** — checks remaining memberships after deletion. If others exist, auto-switches to the first one and stays in the app. If none remain, redirects to `/(welcome)/` directly (not via onboarding).
- **Delete account** — calls `delete_my_account()` RPC. Blocked if user is admin of a business with other active members. User must type `SUPPRIMER` to confirm.
- **Privacy + support links** — "Politique de confidentialité" opens `https://patron.kolilink.com/privacy.html`; "Contacter le support" opens `https://wa.me/12672421843`.

### Theme (`src/theme/`)

Import from `@/src/theme` — `palette` for semantic tokens, `colors` for the full scale, `typography` for text styles, `spacing` for layout values. Primary color is indigo (`#6366F1` / `colors.primary[500]`). Role colors: administrateur=indigo, manager=cyan, vendeur=green, investisseur=amber.

**Never use hardcoded hex values in screens** — always reference `palette` tokens.

### UI components (`src/components/ui/`)

Use the shared components before building ad-hoc ones: `Button`, `Card`, `Text`, `Input`, `DatePickerField`. Import via `@/src/components/ui`. The `Text` component accepts semantic variants (h1–h4, body, label, caption, amount) that map to `typography` tokens.

### Types (`src/types/index.ts`)

All domain types live here. Key ones:
- `Role`: `administrateur | manager | vendeur | investisseur`
- `OrderStatus`: `brouillon | confirme | annule | paye | credit`
- `AppSession`: `{ user, activeBusiness, activeMembership, memberships }`
- `Business`: multi-tenant entity with per-business `currency` field

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
| `db/migration_v21.sql` | `invite_attempts` rate-limit table; `validate_invite_code()` SECURITY DEFINER RPC (5 attempts/10 min); admin/manager-only UPDATE on memberships; pg_cron cleanup job (manually enable) |
| `db/migration_v22.sql` | `get_best_sellers()` RPC; `submit_sale()` + `cancel_sale()` SECURITY DEFINER RPCs; removes vendeur INSERT access on `stock_moves` |
| `db/migration_v23.sql` | `delete_my_account()` SECURITY DEFINER RPC — blocks if admin has active members, otherwise deletes businesses (sole-admin), memberships, profile, and auth user |

`discount_amount` convention: `total_amount` always stores catalog total; `discount_amount + amount_paid = total_amount` for a closed discounted sale.

`lib/db.ts` — SQLite local migrations (auto-run on app start, versioned in `_migrations` table). Current schema version: 7 (sync_queue).

### Security & role isolation

Four roles: `administrateur`, `manager`, `vendeur`, `investisseur`.

**RLS is the primary gate.** All writes that vendeurs can trigger go through SECURITY DEFINER RPCs (never direct table INSERT):
- `submit_sale(...)` — creates sale_order + so_lines + payment + stock_moves atomically. Enforces that a vendeur can only submit sales in their own name.
- `cancel_sale(p_sale_id, p_business_id, p_reason)` — marks annulé, restores stock. Vendeurs can only cancel their own sales.
- `validate_invite_code(p_code)` — rate-limited (5 attempts/10 min), atomically increments `uses` and returns `{business_id, role}`.
- `get_best_sellers(p_business_id, p_month_start, p_limit)` — server-side aggregation, returns top N products by revenue.
- `delete_my_account()` — safe self-deletion with admin guard.

**Frontend is defense-in-depth** (not the primary control):
- Catalogue + Vendre tabs hidden for investisseur (`href: null` in tabs layout).
- `fetchSales` passes `sellerId` filter for vendeurs so they only see their own sales.
- `ventes/index.tsx` defaults to a 90-day window; "Voir tout l'historique" toggle re-fetches without the date filter.

### Supabase client (`lib/supabase.ts`)

Uses `expo-secure-store` for session storage with custom 2 KB chunking (SecureStore has a per-key size limit, so tokens are split across multiple keys). The `@/` alias maps to the project root (configured in `tsconfig.json`).

### Edge Functions (`supabase/functions/`)

| Function | Purpose |
|---|---|
| `create-phone-verification` | Creates OTP row, sends WhatsApp via Twilio. Bypasses for `DEMO_PHONE` env var (App Store review). |
| `whatsapp-inbound-webhook` | Marks verification row as `verifie` when user sends token back via WhatsApp |
| `restore-phone-session` | Generates magic link for verified phone, returns `token_hash` for `verifyOtp` |
| `send-whatsapp-otp` | Twilio WhatsApp message dispatch |
| `verify-phone-otp` | OTP verification helper |
