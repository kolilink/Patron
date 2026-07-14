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

# Type-check
npx tsc --noEmit

# OTA update (JS-only changes — no native rebuild needed)
npx eas update --channel production --message "description"

# EAS build + submit to App Store / Play Store
eas build --platform ios --profile production
eas build --platform android --profile production
eas submit --platform ios --profile production
eas submit --platform android --profile production

# Full pre-merge gate: type-check + jest (mocked-Supabase unit tests) +
# consistency checks (palette-only colors, <Screen> as every screen root —
# see scripts/lib/consistency-checks.js). Fast, hermetic, no Docker needed.
npm run check

# Integration tests — run the REAL submit_sale/cancel_sale/join_business
# Postgres functions (not a mocked supabase.rpc) against a local Supabase
# instance. Requires Docker (Colima works on older macOS where Docker
# Desktop's cask requires Sonoma+). One-time + per-run:
npm run test:db:start     # supabase start — local Postgres+Auth+PostgREST
npm run test:db:reset     # applies db/schema.sql + all db/migration_v*.sql in order
npm run test:integration  # jest --config jest.integration.config.js
```

Jest suite in `__tests__/` (offline queue, submit_sale, cart logic, role/session, error handling — no UI/component tests, all mock `supabase.rpc`). `__tests__/integration/` is separate: real RPC calls against a local Supabase instance — see "Integration tests" below. No linting config beyond the consistency-check script.

## UI components (`src/components/ui/`)

### Screen — required root for every screen

**Every screen file must use `<Screen>` as its root element, not `<SafeAreaView>` directly.**

```tsx
import { Screen } from '@/src/components/ui/Screen';

// Standard screen (top + bottom safe area):
return <Screen>...</Screen>;

// Tab-bar screen (top only — bottom handled by tab bar):
return <Screen tab>...</Screen>;

// Escape hatch for unusual edge needs:
return <Screen edges={['top']}>...</Screen>;
```

`Screen` applies `flex: 1`, `backgroundColor: palette.background`, and the correct safe area edges automatically. Using raw `<SafeAreaView>` as a screen root is a violation — it's easy to forget `edges` and content ends up behind the notch or home indicator. `SafeAreaView` is still allowed inside `<Modal>` components (for modal sheet inner wrappers).

This rule (and the "never hardcode hex" rule under Theme below) is enforced by `scripts/lib/consistency-checks.js`, run via `npm run check` — an import-based check for `SafeAreaView` usage (not a same-line grep, so legitimate Modal-nested usages aren't flagged) and a hex-literal grep over `app/`, `src/`, `stores/`.

`scripts/daily-rapport.js` (the GitHub Actions daily email, `.github/workflows/daily-rapport.yml`) used to run its own inline version of the SafeAreaView check: grep every `SafeAreaView` line, then drop lines containing the literal text `Modal`. Since `<Modal>` is virtually always several lines above `<SafeAreaView>`, not on the same line, that filter almost never matched — every legitimate Modal-nested `SafeAreaView` (imports, open tag, close tag) was being reported as a violation, ~64 false positives a day. It now imports the same `scripts/lib/consistency-checks.js` used by `npm run check`, so both surfaces agree and the report reflects real violations (0, currently) instead of noise.

## Architecture

### Routing (Expo Router v6 file-based)

```
app/
  _layout.tsx           — Root layout: initializes auth + SQLite, hides splash
  index.tsx             — Redirects to (welcome) or (app) based on session
  (welcome)/            — Unauthenticated: index, connexion, creer, rejoindre
  (app)/
    _layout.tsx         — Guards: redirects to /(welcome)/ if no session. Mounts SyncBanner
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
    support/            — Merchant → founder support chat (single thread per business)
    support-inbox/      — Founder-only: all open support threads across every business
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

### WhatsApp OTP Android autofill (`modules/sms-retriever/`)

Android equivalent of the iOS `textContentType="oneTimeCode"` autofill above — but iOS gets that for free from the OS, while Android needs actual native code, because WhatsApp's "one-tap"/"zero-tap" authentication-template autofill button delivers the code via the same on-device broadcast Google's **SMS Retriever API** listens for (`com.google.android.gms.auth.api.phone.SmsRetriever`, action `SMS_RETRIEVED_ACTION`) — it is not a real carrier SMS, WhatsApp itself fires the broadcast, but the receiving mechanism is identical. That's also why the 11-character "app signature hash" WhatsApp Business Manager asks for is computed with the exact same algorithm as Google's `AppSignatureHelper` (`base64(sha256(packageName + " " + hexCert))[:9 bytes]`) — it has to match whatever certificate actually signs the APK on the user's device. Since Play App Signing is enabled for Patron, that's the **App signing key certificate** shown in Play Console → Protected with Play → Play Store protection → "Protect app signing key" → Manage Play app signing (not the upload key below it, and not derivable from the SHA-1/SHA-256 fingerprints shown there — those are hashes *of* the cert, not the raw cert bytes the algorithm needs; the actual bytes have to come from a real signed APK, e.g. via Play Console's App bundle explorer → Downloads → Signed, universal APK).

`modules/sms-retriever/` is a local Expo Module (Android-only per `expo-module.config.json`) wrapping `SmsRetrieverClient`. `OtpInput`'s `whatsappAutofill` prop (only set on the four screens where the code actually arrives via WhatsApp: `connexion.tsx`, `creer.tsx`, `rejoindre.tsx`, `milestone/phone.tsx` — deliberately not on `recuperation.tsx`, which is email-based) starts the retriever and auto-fills on a matching broadcast. This hash is a **one-time registration**, not per-build: Google holds the App signing key permanently and re-signs every future release with it, so new version codes/EAS builds never require re-registering with WhatsApp — only an explicit "Upgrade your app signing key" action in Play Console would invalidate it. The native receiver itself, however, only ships in the app once a version built after this module was added goes out — an OTA `eas update` alone will not activate it, since it's native (Kotlin) code, not JS.

### Biometric-only lock (`lib/lock.ts` + `app/(auth)/verrouille.tsx`)

There is **no PIN anywhere in the app** (removed in migration_v131, which also dropped `profiles.pin_hash`/`pin_updated_at` and the pre-existing dead `memberships.pin_hash` column). Re-entry after any lock is Face ID/Touch ID only, falling back to a full WhatsApp OTP re-login when biometric is unavailable, unenrolled, or hard-fails — this was a deliberate product decision, confirmed explicitly: even though it means a non-biometric device hits a full OTP round trip on *every* qualifying lock (not just a killed-and-relaunched app), not just occasionally.

One mechanism handles both triggers that used to be two separate, inconsistent ones (a route-based PIN screen for cold start, and a separate in-place blur overlay for backgrounding — the latter used to fail *open*, silently granting access, when no biometric was enrolled; that gap is closed by having only one path, which never fails open):
- **Cold start**: `useAuthStore.locked`, checked via `isLocked()` at the very start of `initialize()` before any session hydration — a killed-and-relaunched app lands on `/(auth)/verrouille` instead of silently opening back inside.
- **Background-return**: folded into the existing foreground-sync `AppState` listener in `app/(app)/_layout.tsx` (not a separate listener) — tracks how long the app was backgrounded in a ref, and if it was ≥ `BACKGROUND_MS` (3 minutes) on return to `'active'`, calls `lock()` and skips that tick's `refreshActiveBusiness()`/`trySync()` since a redirect is about to unmount the tree anyway.

Both routes converge on the same `lock()`/`verrouille.tsx` pair:
- `lock()` (from Paramètres → "Verrouiller", or the background timer above) sets a soft-lock flag via `setLocked(true)` — it deliberately does **not** touch the Supabase session, refresh token, or any domain store. That's what lets `unlockWithBiometric()` restore the session for free (via `loginWithBiometric()`) with no WhatsApp OTP. `logout()` remains the only path that wipes everything, for signing out / switching accounts — now also the only fallback when biometric itself is unavailable, since there's no PIN.
- `unlockWithBiometric()` (`stores/auth.ts`) returns one of `'unlocked' | 'retryable' | 'unavailable' | 'restore-failed'`, not a bare boolean — collapsing every failure into one boolean would make an accidental cancel or an interrupted Face ID prompt indistinguishable from "no biometric hardware at all," forcing an unnecessary full sign-out. `'retryable'` (cancel, interruption, a single bad read) offers an immediate re-prompt from `verrouille.tsx`; only `'unavailable'` (no hardware/enrollment, or a hard failure like `lockout`/`passcode_not_set`) degrades to a full OTP re-login. `'restore-failed'` means biometric succeeded but `loginWithBiometric()` couldn't refresh the session (e.g. offline) — this must never be treated as a failed auth attempt or forced into a sign-out, since the user did nothing wrong.
- `authenticateAsync` is called with `disableDeviceFallback: true` — the SDK defaults this to `false`, which would silently let the OS's own device-passcode prompt stand in for biometric, undercutting "no PIN fallback anywhere" the moment a user hits a couple of failed Face ID reads.
- A module-level `_biometricPromptInFlight` guard in `unlockWithBiometric()` drops a second call outright while one is still pending, instead of letting it reach `authenticateAsync` again — `expo-local-authentication` supports exactly one in-flight prompt per app, so a stacked call could in principle be silently rejected by the OS with no UI. In practice this wasn't the cause of the bug below, but it's a real race worth guarding regardless. The mount-time auto-attempt in `verrouille.tsx` is also deferred with `InteractionManager.runAfterInteractions` so it doesn't fire mid-route-transition. Failures log the real `result.error` to Sentry (`biometric_authenticate_failed`/`_threw`) since collapsing straight to `'retryable'`/`'unavailable'` hides the actual native reason — this is what diagnosed the bug below.
- **Tapping "Réessayer" silently did nothing on a real device — no Face ID sheet, no error, nothing.** Root cause, found by temporarily surfacing `result.error` on-screen: `missing_usage_description`. `app.json`'s `ios.infoPlist.NSFaceIDUsageDescription` was correct and had been for a long time, but Info.plist values are baked into the app at **native build time** — a JS reload or an `eas update` OTA push can never deliver them, since OTA only ships the JS bundle over the existing native shell. The device had a native binary installed from before this key made it into an actual `eas build`. No code fix exists for this class of bug; the only remedy is a fresh `eas build` (matching whatever profile/distribution the test device uses) followed by reinstalling that build, not another OTA update. Same category as the SMS-retriever native module documented above — always check "was this delivered by an OTA update or a real native build?" before debugging any permission/native-module symptom that reads as "nothing happens at all."

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

### Support chat — merchant ↔ founder (`stores/supportChat.ts`, `db/migration_v126.sql`)

A separate system from the "Chat system" above, not an extension of it — deliberately its own tables (`support_conversations`, `support_messages`, `support_ai_drafts`) rather than reusing `chat_rooms`/`chat_messages`, because that schema's RLS (`is_global=true OR is_member(business_id)`) has no concept of "the founder reads across every business," and retrofitting it risked weakening the boutique/marché isolation. Replaces the former `wa.me` WhatsApp link that used to be the Accueil "Support" quick-action button (`app/(app)/(tabs)/index.tsx`) — the equivalent link in Paramètres → "Contacter le support" is untouched, left as a fallback.

**Human-in-the-loop only.** An AI (Groq, `llama-3.3-70b-versatile` — free tier, open-weight; picked over a paid model because the founder reviews every draft before anything is sent, so a 70B-class open model is an acceptable quality tradeoff at zero marginal cost) drafts a suggested reply after every merchant message, but it is architecturally incapable of reaching a merchant directly:
- The draft lives in its own table, `support_ai_drafts`, whose *only* RLS policy is `USING (is_founder())` — no merchant-visible policy exists on that table at all. This makes founder-only visibility a schema-level guarantee, not something a screen has to remember to filter.
- The only INSERT path for a founder-authored `support_messages` row is `send_founder_support_reply()`, a SECURITY DEFINER RPC gated on `is_founder()` and a real `auth.uid()` — the `generate-support-draft` edge function's service-role key never writes to `support_messages`, only to `support_ai_drafts`.

**Founder identity is a global `profiles.phone` match** (`is_founder()`, `get_founder_id()` in `db/migration_v126.sql`), not a per-business role — Sebastiao is also an `administrateur` of his own business ("Maillot Commerce"), so the check has to be independent of any `memberships` row. Client-side gating (`src/utils/founder.ts`'s `isFounderPhone`) mirrors the same phone-digit comparison for the founder-only screens (`app/(app)/support-inbox/`) — defense-in-depth only, same posture as the investisseur tab-hiding pattern; RLS is the real enforcement, verified directly against a local Postgres instance before any client code was written (a merchant session confirmed to get zero rows from `support_ai_drafts`, a founder session confirmed to see every business's conversations).

**One open conversation per business**, not a multi-ticket system — mirrors the existing one-boutique-room-per-business precedent. A `status` (`open`/`closed`) lets the founder close a resolved thread from the inbox; a new merchant message reopens it via `send_support_message()` rather than creating a new row (enforced by a partial unique index on `business_id WHERE status='open'`, so a race between two concurrent get-or-create calls can't create two open rows).

**Offline queueing is deliberately not the SQLite `sync_queue`** used for `submit_sale`/`create_expense` — support messages aren't financial data, so a lighter KV-backed queue (`getKV`/`setKV`, key `support_pending_messages`) is enough, drained via `drainSupportQueue()` from the same `AppState` foreground listener in `app/(app)/_layout.tsx` that already drains the real sync queue.

Requires the `GROQ_API_KEY` Supabase Edge Function secret to be set before `generate-support-draft` will produce real drafts — without it the function persists a `status='failed'` draft row (founder inbox shows "La suggestion n'a pas pu être générée") rather than blocking the merchant's message send, which always succeeds independently of AI draft generation.

### Image messages (`lib/chatImages.ts`, `db/migration_v132.sql`)

Images in boutique chat (incl. partner DM rooms, which share `chat_messages` via `room_id`), and merchant↔support chat. **Le Marché is deliberately excluded** — it's a public forum across every business on the platform, not a bounded-audience surface like the other two, and images there would be unmoderated public image hosting; revisit only as its own scoped decision.

Reuses the `message_type` pattern voice messages established in v90/v91/v92 (`'text' | 'voice' | 'image'` on `chat_messages`; `support_messages` gained the same three columns fresh in v132, since it never had voice). One shared public bucket, `message-images`, path-namespaced `{context}/{room_or_conversation_id}/{message_id}.jpg` — not a bucket per surface — because the RLS policy is identical across both (any authenticated user upload/read, access actually gated at the message-row level, same posture as `voice-messages`).

`lib/chatImages.ts`'s `uploadMessageImage()` is the one shared upload path for both surfaces: resizes to a 1600px longest edge via `expo-image-manipulator` (only shrinks, never upscales — the low-bandwidth constraint that's the whole reason this app exists), compresses to JPEG ~0.7, then reads/uploads via the same base64-decode workaround voice messages use (`fetch().blob()` returns 0-byte blobs for `file://` URIs in Hermes). `image_width`/`image_height` are captured at upload time and stored alongside `image_url` so `ImageMessageBubble` can reserve its final layout size before the image loads — no reflow jank.

**`CREATE OR REPLACE FUNCTION` does not edit a function in place when the argument *count* changes**, even if every new parameter is `DEFAULT`-ed — Postgres creates a second overload and leaves the old signature callable alongside it. v132 added `p_image_url`/`p_image_width`/`p_image_height` to `send_support_message`/`send_founder_support_reply`, and applying it left both the old 2-arg/3-arg and new 5-arg/6-arg versions live simultaneously — ambiguous for PostgREST's named-argument RPC calls whenever a caller supplies only the original params (exactly what the plain-text send path does). Fixed with an explicit `DROP FUNCTION IF EXISTS <old signature>` before each `CREATE OR REPLACE` in v132.sql. Any future migration that adds parameters to an existing SECURITY DEFINER RPC needs the same explicit drop — `CREATE OR REPLACE` alone is not enough once the parameter count changes.

**Support-chat images are not offline-queued**, unlike text messages (which use the lightweight KV queue, `support_pending_messages`) — a network failure just surfaces an error and the user retries manually once reconnected. Re-uploading a multi-hundred-KB file through that queue on reconnect wasn't worth building for v1; if it's ever needed, it belongs in the real SQLite `sync_queue`, not the KV one.

**Jest mocking:** `lib/chatImages.ts` imports `expo-image-manipulator`, which ships unparsed ESM `export` syntax this project's plain `ts-jest` setup doesn't transform (node_modules isn't transformed by default). Mocked via `__mocks__/chatImages.js` in `jest.config.js`'s `moduleNameMapper` — same class of fix as the `react-native-purchases` mock already documented under "Native IAP paywall" below.

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

The online submit path (`stores/sales.ts`) notifies admins/managers right after a successful `submit_sale` call. `lib/sync.ts`'s `executeOp` fires the same `sale_completed` notification after a queued `submit_sale` replays successfully — this was missing until recently, meaning sales made fully offline (this app's core low-connectivity use case) never generated the notification once synced. The lookup (`notifyQueuedSaleSynced`) rebuilds seller name/currency/description from the raw queued payload since no `CartLine`/`Product` objects survive a trip through SQLite, and is best-effort — a lookup failure there must never affect the sync result itself.

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
| `db/migration_v99.sql` | Nightly reconciliation system: `reconciliation_runs` / `reconciliation_findings` tables + `run_reconciliation()` — 68 SECURITY DEFINER checks across 14 domains (stock, sales, payments, COGS, expenses, credit, suppliers, purchase orders, products, monetary precision, members, cross-aggregates, temporal, referential integrity). Run nightly by the `send-reconciliation-report` Edge Function. |
| `db/migration_v103.sql` | `get_financial_snapshot()` — independent ground-truth revenue/COGS/expenses/net-profit recompute straight from the ledger, grouped by business currency (never blended across currencies). Included in the nightly reconciliation email as a sanity-check reference, separate from the 68 structural checks. |
| `db/migration_v104.sql` | Fix: 3 false-positive sources in checks #1, #2, #9 of `run_reconciliation()` — excludes `is_system` placeholder products (e.g. "Solde reporté") from stock checks; aggregates `so_lines` by `(order_id, product_id)` before comparing to `stock_moves` in check #2; check #9 compares `total_amount` against `SUM(qty * COALESCE(unit_price_paid, unit_price))` instead of catalog `unit_price` alone, since a seller can record a sale above catalog price. Reduced a first live run from 41 critical findings to 18 genuine ones. |
| `db/migration_v109.sql` | Pre-launch scale fix: adds missing B-tree indexes on `business_id` (`products`, `stock_moves`, `sale_orders`, `expenses`), `seller_id` (`sale_orders`), and `order_id`/`product_id` (`so_lines`), plus `created_at` (`payments`). Postgres never auto-indexes FK columns, only PKs/unique constraints — every `is_member(business_id)` RLS check and business-scoped screen query had been doing a sequential scan that grows with total rows across *all* businesses, not just one. |
| `db/migration_v112.sql` | Security fix: OTP codes (phone + email) had no limit on how many times a code could be *guessed* — only on how often a new one could be *requested* (5/10min). Adds `failed_attempts` to `phone_verifications` and `email_verifications`; `verify-phone-code`, `recover-by-email`, and `link-recovery-email` now lock a verification row after 5 wrong guesses and use a constant-time comparison on the token. |
| `db/migration_v113.sql` | Security fix: adds `ip_verification_attempts` — a secondary rate limit (20/hour) scoped per IP address across `create-phone-verification` and `send-email-otp`, closing a cost-abuse path where an attacker rotates phone numbers/emails to bypass the existing per-identity limit and run up WhatsApp/Twilio/Resend charges. `DEMO_PHONE` bypass is unaffected. |
| `db/migration_v114.sql` | Fix: check #74 ("Écart revenu commandes vs lignes") in `run_display_checks()` (added by `migration_v111.sql`) had a row fan-out bug — it joined `so_lines` onto `sale_orders` and then summed `so.total_amount`, so a multi-line order's total was counted once per line instead of once per order, inflating the aggregate by up to 7x for some businesses. Verified against production that no real order/line mismatch existed; every affected order's `total_amount` already matched its own lines exactly. Fixed by aggregating order totals and line totals in separate CTEs before comparing. |
| `db/migration_v115.sql` | Capital injections ("Apports") gain correction + reversal support, admin/manager only: `edit_injection()` RPC corrects a mistaken row in place (amount/contributor/note/date) and stamps `edited_at`/`edited_by`; `record_withdrawal()` RPC inserts a **new negative-amount row** rather than mutating history when capital is taken back out, so `SUM(amount)` across `capital_injections` (used by the cash-on-hand and "capital investi" totals in `migration_v110/v111/v114`) naturally reflects withdrawals without any change to those formulas. `capital_injections.amount` CHECK relaxed from `> 0` to `<> 0` to allow the negative rows. Neither RPC is reachable by vendeur/investisseur — same role gate as `record_injection`. |
| `db/migration_v116.sql` | Adds checks 77–78 to `run_display_checks()` (68 structural + 10 display = 78 total, up from 77) to cover the v115 capital edit/withdrawal RPCs: #77 (critical) flags a contributor whose net `capital_injections` position (apports minus retraits) has gone negative — more recorded as withdrawn than they ever contributed; #78 (warning) surfaces any row edited via `edit_injection()` or any withdrawal recorded via `record_withdrawal()` in the last 90 days, giving the founder nightly visibility on these manual overrides, the same way check #72 already surfaces manual `transport_achat` entries. `supabase/functions/send-reconciliation-report/index.ts` check-count text (77 → 78) updated to match. |
| `db/migration_v117.sql` | Fix: `get_reports_snapshot()` (added by `migration_v110.sql`) raised `column sm.variant_id does not exist` on every call — the stock-losses subquery joined `product_variants` on `sm.variant_id`, but `stock_moves` has never had a variant_id column (only `so_lines` / `purchase_order_lines` carry variant_id; stock moves, including `perte` losses, are always product-level). This made the Rapports screen show no data at all, for every business and every role, since the RPC was deployed. Fix: dropped the bogus join, uses the product's own `cost_price` directly. |
| `db/migration_v118.sql` | Fix: `get_reports_snapshot()` still raised `column so.seller_name does not exist` after v117 — the top-sellers subquery grouped by `sale_orders.seller_name`, but that column has never existed (`migration_v62.sql` already documented the same mistake in `submit_carnet_debt`). Seller display name has always been derived client-side (`stores/ventes.ts`): `memberships.display_name` override, then `profiles.name`, then a fallback. Fix: replicates that resolution in SQL via `LEFT JOIN memberships` / `profiles`, grouped by the real `seller_id` column. This was the second of two RPC bugs (after v117) that together made Rapports show no data since `get_reports_snapshot` was deployed in v110. |
| `db/migration_v119.sql` | Fix: `get_reports_snapshot()`'s `activity`/`my_activity` daily series showed "Invalid…" day labels on the Rapports Semaine chart (and silently misplaced bars on Trimestre) for every role. `generate_series(date, date, '1 day'::interval)` returns `timestamp`, not `date`, so `gs.day::text` produced `"2026-06-25 00:00:00"` instead of `"2026-06-25"` — Hermes' `new Date(...)` (used in `app/(app)/rapports/index.tsx` for both the weekday label and the trimestre week-bucket offset) can't parse that non-ISO format. Fix: cast to `gs.day::date::text` before building the JSON payload. |
| `db/migration_v120.sql` | Perf: `create_business_with_membership(p_id, p_name, p_type, p_currency, p_phone)` — SECURITY DEFINER RPC replacing `createBusiness()`'s old pattern of inserting into `businesses` then polling `memberships` up to 5x (600ms apart, ~3s worst case) waiting for the `on_business_created` trigger. The trigger already fires in the same transaction as the insert, so the poll loop was pure client-side over-caution; the RPC now inserts and reads back the membership + business in one round trip. Re-checks the "1 business per user" rule from the `migration_v29` RLS policy manually, since SECURITY DEFINER bypasses table RLS. |
| `db/migration_v121.sql` | Security fix: `get_reports_snapshot()` (v110+) only checked that the caller is a member of `p_business_id` — it never verified the caller actually holds the caller-supplied `p_role`, nor that `p_user_id` was the caller's own id. Any member could pass `p_role: 'administrateur'` to read full business financials regardless of real role, or pass a teammate's `p_user_id` to read that teammate's personal figures. Fix: for any authenticated caller, role and user id are now derived server-side via `get_role()` / `auth.uid()`; the client-supplied `p_role`/`p_user_id` are ignored. The service-role internal-reconciliation path (`auth.uid() IS NULL`) is unaffected. |
| `db/migration_v122.sql` | Fix: restores the `submit_sale` idempotency-race guard from `migration_v52.sql` (`BEGIN...EXCEPTION WHEN unique_violation`), which was silently dropped when the function was rewritten for vendeur product-scope (`v67`) and never restored through any later rewrite (v78/v81/v86/v93/v96/v107). Without it, two concurrent calls sharing an `idempotency_key` (offline-queue retry racing a live retry, or two devices racing post-reconnect) could both pass the pre-check and one would raise a raw `unique_violation` instead of both resolving to the same order. |
| `db/migration_v123.sql` | Retires the standalone 2am UTC `patron-nightly-reconciliation` cron job (`SELECT cron.unschedule(...)`). Reconciliation is now folded into the single 6am ET combined daily report — see "Nightly reconciliation" below. |
| `db/migration_v124.sql` | Security fix, found via `__tests__/integration/`: `join_business`'s rate limiter (5/10min) never actually triggered against a wrong/expired/already-claimed code guess. Its `INSERT INTO invite_attempts` ran before the validation checks specifically so failures would count toward the limit, but a Postgres function invoked by one top-level statement is atomic — an uncaught `RAISE` rolls back everything the call did, including that insert. Only successful joins were ever actually logged. Fix: attempt-logging moved to its own `record_invite_attempt()` RPC (no conditional `RAISE` inside it, so it always commits as its own top-level statement); `join_business()`'s validation logic is otherwise unchanged. Client (`stores/auth.ts`'s `joinBusiness`) now calls `record_invite_attempt()` immediately before `join_business()`. |
| `db/migration_v125.sql` | Correctness fix, found via `__tests__/integration/`: `cancel_sale`'s stock-restore loop added the cancelled qty back onto the *parent* product's `stock_qty` for every line, variant or not — but `submit_sale` never touches a variant parent's `stock_qty` (documented invariant: "always 0 for variant parents"). Every variant-sale cancellation silently drifted the parent further away from 0. Fix: only restore `products.stock_qty` when the line has no `variant_id`; variant stock restoration is unchanged. |
| `db/migration_v126.sql` | In-app support chat (merchants ↔ founder) — see "Support chat" below. Adds `support_conversations`/`support_messages`/`support_ai_drafts`, `is_founder()` + `get_founder_id()` helpers (global `profiles.phone` match, independent of any business membership — Sebastiao is also an `administrateur` of his own "Maillot Commerce"), and an additive `businesses` SELECT policy so the founder can read business names across every business for the inbox list (RLS OR's multiple permissive SELECT policies together, so this only ever widens founder access, never narrows member access). |
| `db/migration_v129.sql` | Cross-device PIN sync fix (superseded — PIN itself was removed in v131; see "Biometric-only lock" above). Added `profiles.pin_hash`/`pin_updated_at` so the local-only salted PIN hash (previously SecureStore-scoped to a single device) could be opportunistically synced across a user's devices. |
| `db/migration_v130.sql` | Re-launches the subscription paywall via native Apple/Google IAP (RevenueCat) instead of the old in-app Stripe Payment Link flow — see "Native IAP paywall" below. Adds `businesses.payment_provider`/`revenuecat_customer_id`/`bonus_access_until`/`referred_by_business_id`/`referral_code`; `subscription_tier` (gratuit/starter/business/pro) is legacy/unused, left in place but no longer read by `lib/analytics.ts`. |
| `db/migration_v131.sql` | Removes the PIN-lock feature entirely (see "Biometric-only lock" above) — drops `profiles.pin_hash`/`pin_updated_at` (added by v129, now dead) and the separate, pre-existing, never-used `memberships.pin_hash` column. |
| `db/migration_v132.sql` | Image messages in boutique chat (+ partner DMs) and support chat — see "Image messages" above. Extends `chat_messages.message_type` CHECK to include `'image'` (reusing the v90/v91 voice-message pattern) and adds `image_url`/`image_width`/`image_height`; adds the same three columns fresh to `support_messages`, whose two RPCs (`send_support_message`, `send_founder_support_reply`) gain optional `p_image_url`/`p_image_width`/`p_image_height` params and only require non-empty `content` when no image is attached. Rebased those two RPC bodies onto the *live* v127 version (not v126's original — v127 had already added a `merchant_name` refresh-on-send that a naive v126-based rewrite would have silently reverted). Explicitly `DROP FUNCTION`s the old 2-arg/3-arg signatures before recreating — see "Image messages" above for why `CREATE OR REPLACE` alone left both old and new overloads live and ambiguous. Creates the shared public `message-images` storage bucket. Le Marché is out of scope (see above). |
| `db/migration_v133.sql` | The AI business advisor (launched as "Mystic", renamed to "Alpha" by v134 below) — see "Alpha" above. Added `mystic_conversations` (one per business+user), `mystic_messages`, `mystic_quota` (one rolling-24h-window tracker shared by both the free 3/24h and paid 100/24h tiers); `has_ai_access()` (SQL-side mirror of the client's `isSubscriptionExpired`/`hasBonusAccess`); `open_or_get_mystic_conversation`, `send_mystic_message` (the sole quota-enforcement point), `get_mystic_quota_status` (read-only, for the client's countdown/upsell UI). All `mystic_*` names were superseded by v134 — this row is history, not the current schema. |
| `db/migration_v134.sql` | Renames the AI advisor's schema from `mystic_*` to `alpha_*` (tables, indexes, RLS policy labels, and all three RPCs). `has_ai_access()` untouched (never Mystic-specific). Plain `ALTER TABLE/INDEX RENAME` isn't sufficient for the RPCs — plpgsql bodies resolve table/function names as text at execution time, not by OID, so `send_mystic_message`'s internal call to `open_or_get_mystic_conversation()` and its `FROM mystic_messages` queries would have broken the moment the underlying objects were renamed out from under them. The three RPCs are dropped and recreated under their `alpha_*` names with bodies rewritten throughout — same logic as v133, new names. |
| `db/migration_v135.sql` | Stopgap: lowers `send_alpha_message`/`get_alpha_quota_status`'s paid-tier `v_limit` from 100/24h to 20/24h. Groq blocked new Developer-tier signups org-wide starting sometime before 2026-07-13, leaving Alpha stuck on Groq's Free tier (100,000 tokens/day, shared across the whole platform plus `generate-support-draft`) — at realistic per-reply token cost that only sustains ~60-100 total exchanges/day platform-wide, so the original 100/24h-per-business figure could let one active paying customer alone starve every other business's access for the rest of the day. Free tier (3/24h) and the 10-message welcome burst are untouched. Revert to 100 (or reassess) once Groq's Developer tier reopens — see "Billing" under "Alpha" above. |
| `db/migration_v136.sql` | Raises the free tier's `v_limit` from 3/24h to 5/24h in the same two functions, as part of a quota-UX pass distinguishing free-tier-exhausted (upgrade popup) from paid-tier-exhausted (plain wait state) — see "Free vs. paid exhaustion" under "Alpha" above. Welcome burst (10) and paid tier (20, still `migration_v135.sql`'s stopgap value) are untouched. |

(Note: `migration_v58.sql` through `v75.sql`, `v77.sql` through `v98.sql`, `v100.sql` through `v102.sql`, `v105.sql` through `v108.sql`, and `v110.sql` exist in `db/` but are undocumented here and unrelated to this entry — out of scope. `migration_v111.sql` adds `run_display_checks()` / `refresh_reconciliation_run()`, patched by `v114.sql` above.)

`discount_amount` convention: `total_amount` always stores catalog total; `discount_amount + amount_paid = total_amount` for a closed discounted sale.

`lib/db.ts` — SQLite local migrations (auto-run on app start, versioned in `_migrations` table). Current schema version: 7 (sync_queue).

### Native IAP paywall (`lib/purchases.ts` + `src/components/PaywallScreen.tsx` + `supabase/functions/revenuecat-webhook/`)

`app/(app)/_layout.tsx`'s gate (`isSubscriptionExpired`) previously hardcoded `return false` — the app was free during early access, and the real paywall used `Linking.openURL` to open Stripe Payment Links from inside the app, which is a Guideline 3.1.1 violation (a digital subscription unlocking in-app functionality must go through platform IAP, not a web checkout). Re-launched via RevenueCat (`react-native-purchases`) instead: `PaywallScreen.tsx` calls `Purchases.purchasePackage()`, and `supabase/functions/revenuecat-webhook/index.ts` (mirroring `stripe-webhook`'s structure) updates `businesses.subscription_status`/`subscription_expires_at`/`payment_provider` server-side on `INITIAL_PURCHASE`/`RENEWAL`/`EXPIRATION` events. `Purchases.logIn(business.id)` is called from `stores/auth.ts` so RevenueCat's `app_user_id` always equals `businesses.id` — same identity convention the old Stripe flow used via `client_reference_id`.

**As of Alpha's launch (`migration_v133.sql`), `isSubscriptionExpired`/`hasBonusAccess` no longer gate the whole app.** `app/(app)/_layout.tsx` used to swap the entire `<Stack>` for `<PaywallScreen>` once a business's trial lapsed — that forced block was removed; every other screen (Rapports, Catalogue, etc.) is free forever now, for every role. The same `subscription_status`/`trial_ends_at`/`bonus_access_until` fields are repurposed to mean "has Alpha access" instead of "has app access" — same RevenueCat webhook, same columns, just read from a different place (`has_ai_access()` in SQL, checked inside `app/(app)/alpha/index.tsx` for every role, not just the administrateur the old whole-app gate special-cased). `TrialBanner` and the manual `showPaywallManually` preview path stay in `_layout.tsx` as a soft upsell surface, re-pointed at Alpha specifically. See "Alpha" below.

**`lib/purchases.ts` is a safe no-op until `EXPO_PUBLIC_REVENUECAT_API_KEY_IOS`/`_ANDROID` are set** (no RevenueCat project/App Store Connect/Play Console products exist yet at the time this was built) — every exported function checks `isPurchasesConfigured()` first, so the rest of the app (trial, gate logic) works fine in the meantime, and `PaywallScreen` falls back to hardcoded display prices when `Purchases.getOfferings()` has nothing configured.

**Referral bonus (`bonus_access_until`, distinct from `subscription_expires_at`).** "Inviter un ami" in Paramètres grants 30 bonus days to both businesses the first time a referred business converts to a real paid subscription (checked in the webhook's `INITIAL_PURCHASE` handler, guarded by `payment_provider IS NULL` on the referred business so a later renewal never re-triggers it). The bonus is deliberately written to its own `bonus_access_until` column, not `subscription_expires_at` — that field is fully owned by RevenueCat's renewal events and gets overwritten on every `RENEWAL`, which would silently erase the bonus on the referred business's very next billing cycle if it lived there instead. `isSubscriptionExpired()` checks both fields independently so the bonus stacks on top of whatever IAP state exists rather than fighting it.

**`resolve_referral_code(p_code)` is SECURITY DEFINER** because a brand-new user creating their first business isn't a member of the referrer's business yet, so the normal `is_member(id)` SELECT policy on `businesses` would otherwise block looking up the referrer's id from their code — same shape as `validate_invite_code`. The actual write (`referred_by_business_id`) on the new business is a plain client-side update, allowed by the existing "Administrateurs: modifier leur commerce" policy since the new user is that business's own admin.

Jest's plain `ts-jest` setup (no `jest-expo` preset — see "Integration tests" below for why) doesn't transform `node_modules`, and `react-native-purchases` (like `react-native` itself) ships unparsed Flow/ESM syntax — `@/lib/purchases` is mocked via `__mocks__/purchases.js` in `jest.config.js`'s `moduleNameMapper`, placed *before* the generic `'^@/(.*)$'` entry since Jest uses the first matching key.

### Alpha — AI business advisor (`stores/alpha.ts`, `supabase/functions/alpha-chat/`, `db/migration_v133.sql` + `migration_v134.sql`)

Pure conversational Q&A — a merchant asks about their own sales/stock/cash and gets advice grounded in real numbers, via the same Groq (`llama-3.3-70b-versatile`) integration `generate-support-draft` already uses. No proactive jobs, no push notifications, no voice/transcription (Groq's Whisper is excellent for French but genuinely weak for Guinea's local languages — Susu, Malinké, Pular — an unsolved industry-wide gap, not a vendor choice; deferred, not built). Originally shipped as "Mystic" — renamed to "Alpha" one migration later (`migration_v134.sql`) since an English mystical-sounding name sat oddly in an all-French UI for a feature whose whole point is grounded, numbers-based trust, not magic.

**Grounding**: `alpha-chat` calls the existing `get_reports_snapshot`/`get_stock_velocity` RPCs with the **caller's own JWT-scoped client**, never service-role — both RPCs derive role/user_id from `auth.uid()` internally (the v121 security fix), so a service-role call would silently hit the internal-reconciliation code path instead of the caller's real role-gated data. Snapshot values are converted from cents to display units before ever reaching the prompt; low-stock/rupture detection is computed in the edge function from `get_stock_velocity`, not left to the model to infer from raw numbers.

**One conversation per (business, user), not per business** — mirrors `support_conversations`' one-row pattern but keyed on `(business_id, user_id)`: a vendeur's answer (personal figures only) and an administrateur's answer (full P&L) must never land in the same shared thread the way the boutique chat room intentionally shares one thread per business.

**Quota model: one rolling-24-hour-window mechanism for both tiers, never true "unlimited."** Free: **5 messages/24h as of `migration_v136.sql`** (raised from 3 so the free-tier counter reads as a real trial rather than an instant wall). A business with `has_ai_access()` (mirrors `isSubscriptionExpired`/`hasBonusAccess`, SQL-side): **20 messages/24h as of `migration_v135.sql`** (temporarily lowered from the original 100 — see "Billing" below; bump back up once Groq's Developer tier reopens) — marketed as "Illimité" in the UI, which deliberately never states the actual number, so lowering it doesn't require a copy change. The first 10 user messages ever in a conversation bypass the window entirely (the "welcome burst") so a brand-new merchant's first session never hits friction. All enforcement is inside `send_alpha_message` (SECURITY DEFINER) — never client-side; `get_alpha_quota_status` is a read-only companion for the client's live countdown/upsell UI.

**Billing**: `GROQ_API_KEY` needs Groq's **Developer (pay-as-you-go) tier**, not the free tier — the free tier caps `llama-3.3-70b-versatile` at 100,000 tokens/day **shared across the whole Groq org** (every business, plus `generate-support-draft`), nowhere near enough once Alpha is used daily. Adding a card is not enough by itself: as of 2026-07-13, Groq's console shows "Developer tier upgrades are temporarily unavailable due to high demand" org-wide — billing only activates once the org is actually upgraded to a paid tier, so a card on file while still on Free doesn't raise limits or get charged. No code depends on which tier is active, but the feature is unusable at any real scale until Groq lifts this block; check the Groq console periodically rather than assuming it's a one-click fix. At ~900-1,600 tokens per Alpha reply (system prompt + history + output), the 100K/day Free-tier ceiling only sustains ~60-100 total exchanges/day across the whole platform — `migration_v135.sql` lowered the paid tier's quota from 100/24h to 20/24h as a stopgap so one active paying business can't exhaust every other business's access for the rest of the day.

**Conversation history bug (fixed 2026-07-13):** `alpha-chat/index.ts` fetched prior messages with `.order('created_at', { ascending: true }).limit(N)` — ascending+limit returns the *oldest* N rows, not the most recent. Past N total messages in a conversation, that permanently excludes everything newer, including the question this very call is answering (already inserted by `send_alpha_message()` before the edge function runs) — Alpha would silently stop reading the user's actual question and just keep re-answering frozen early context, forever, for that thread. Fixed to `.order(..., { ascending: false }).limit(10)` then `.reverse()` — fetches the most recent 10 messages, restores chronological order. Also trimmed the window from 20→10: that history is resent in full on every single Groq/OpenAI call, so it's the main lever on cost-per-message alongside the 400-token output cap in `callChatCompletions`. Any future change to this query needs both halves (DESC + reverse) — ascending+limit alone reintroduces the bug.

**Groq-first, OpenAI-fallback (added 2026-07-13):** `generateReply()` in `alpha-chat/index.ts` tries Groq first, and the instant that call fails for *any* reason (daily token ceiling hit, rate limit, outage), the same request falls through to OpenAI (`gpt-4o-mini`) automatically — no manual cutover. This was a deliberate choice over a budget-exhaustion-triggered switch: Groq's 100K-tokens/day ceiling is a shared, same-day pool with no advance warning before it's hit, so there's no reliable moment to "predict" and schedule a cutover around — the failing request itself is the only real signal. Both Groq and OpenAI speak the same OpenAI-compatible chat-completions shape, so `callChatCompletions()` is one shared function parameterized by base URL/key/model rather than two near-duplicate implementations. The `alpha_messages.model` column now records whichever model actually served each reply (previously hardcoded to `GROQ_MODEL`) — check that column to see how often the fallback is actually firing. Free and paid tier both go through the same fallback path; nothing routes them to different providers on purpose. `generate-support-draft` (the founder support-chat drafter, sharing the same Groq token budget) does **not** have this fallback yet — it still fails closed to a `status='failed'` draft row if Groq is unavailable, since a missed AI draft there just means the founder replies without a suggestion, not a broken live conversation. Requires the `OPENAI_API_KEY` Supabase Edge Function secret to be set (Restricted-permission key, "Model capabilities" scope only) or the fallback silently has nothing to fall through to.

**"Aladji" bug — a salesperson described as a product (fixed 2026-07-13):** `get_reports_snapshot`'s `top_sellers` field is a **staff revenue leaderboard** (who on the team sold the most — same data rendered as "meilleurs vendeurs" in the Rapports screen, grouped by `seller_id`), not product data. `alpha-chat/index.ts`'s `buildDataBlock` was mapping it into a field literally called `meilleurs_produits` ("best products") in the JSON handed to the LLM — so when a solo-vendeur business's top (and only) seller was named "Aladji", Alpha confidently described "le produit Aladji" and suggested restocking it, because the data block told it, in effect, that Aladji was a product. Fixed: renamed to `meilleurs_vendeurs`, and added a genuine product-level query (`get_best_sellers(business_id, month_start, limit)`, already used by the Accueil dashboard) mapped to `produits_les_plus_vendus`. The system prompt now explicitly states the two lists are never interchangeable — a name in `meilleurs_vendeurs` is always a person, a name in `produits_les_plus_vendus` is always a catalog item. `get_best_sellers` has no role gate of its own (unlike `get_reports_snapshot`, which derives role from `auth.uid()` internally), so it's only fetched for administrateur/manager/investisseur — fetching it for a vendeur would leak every other seller's product revenue to someone who's only supposed to see their own sales.

**Vague/near-empty messages produced a full generic answer, not a clarifying question:** `send_alpha_message` only rejects a message that's empty after `trim()` — a single character or a stray "ok" passes validation, consumes a quota slot, and (before this fix) the system prompt had no instruction telling the model to recognize a non-question, so it just dumped the same "Données du commerce" summary every time regardless of what was typed. Fixed by adding an explicit prompt rule: on a message too short/vague to be a real question, Alpha must ask a short clarifying question with 1-2 concrete examples instead of restating the snapshot. This is prompt-level, not a stricter server-side length check — the goal was Alpha behaving like it's actually listening, not blocking short input outright.

The first version of that rule wasn't strict enough: on a follow-up vague message ("Autre chose"), Alpha asked a clarifying question but *also* cited real seller names/amounts from "Données du commerce" as part of the examples and still appended an "Action à faire" section — exactly the generic-answer behavior the rule was meant to prevent, just wrapped in a question. Tightened the prompt rule to state explicitly that a clarification response must contain *nothing else* — no figures, no names, no action section, only generic topic examples (ventes/stock/dépenses/trésorerie/crédit) — and that real data may only be cited once the merchant has asked an actual specific question.

**Bold key figures (added 2026-07-13):** requested so the 1-3 most important numbers in a reply are visually scannable on a small screen. The prompt now asks Alpha to wrap its most important figures in `**bold**` markdown, capped at 1-3 per reply (over-bolding defeats the point). The chat bubble in `app/(app)/alpha/index.tsx` is plain `<Text>` with no markdown renderer, so a `renderBold()` helper splits assistant message content on `**...**` and renders matched segments as bold nested `<Text>` — applied only to assistant messages (`!isOwn`), since a user's own message is never expected to carry that markup.

**Vouvoiement (added 2026-07-13):** nothing in `STATIC_INSTRUCTIONS` ever told the model how to address the merchant, so it defaulted to "tu" on its own (likely pattern-matching "ton direct, concret" in the tone rule). Added an explicit rule to always address the merchant as "vous" — a basic mark of respect toward someone running their own business, not just a formality.

That first version of the rule didn't survive in an *existing* conversation: the last-10-messages window resent on every turn (see "Conversation history bug" above) still contained several assistant turns from before the fix that used "tu", and the model kept imitating its own established register from that history over the system prompt's instruction — a live conversation doesn't reset just because the system prompt changed underneath it. Strengthened the rule to explicitly tell the model that any "tu" in its own prior messages in this same thread was a mistake to silently correct, never continue. Also tightened the "Action à faire cette semaine" rule the same session: it was appearing as a bare `Action à faire cette semaine : ?` on clarification-question replies — the model held onto the heading text (pattern-completing its own template from real prior answers) while dropping the content it was told to omit. Fixed by naming the exact failure mode in the rule (never emit that heading empty, placeholder, or question-marked) and restating that it belongs *only* to non-clarification replies. A genuinely fresh conversation is the cleanest way to verify either fix — an existing thread's older turns take a few exchanges to age out of that 10-message window.

**Staff-name pseudonymization before hitting Groq/OpenAI (added 2026-07-13):** the only personally-identifying data Alpha ever sends a third party is `meilleurs_vendeurs` — real staff names each tied to their individual revenue. `buildDataBlock` now replaces each name with a positional label ("Vendeur A", "Vendeur B", …) before the data block is built, and returns a `nameToLabel` map alongside it. Three places need that map, not just the outgoing data block, or the protection is incomplete: (1) the fresh data block itself; (2) the resent conversation history (`turns`, fetched from `alpha_messages`) — those rows are stored with real names for the merchant's own chat view, so they're anonymized on the fly via `replaceNames()` right before being sent as context, never mutating the stored rows; (3) the model's new reply, which naturally comes back referring to "Vendeur A" — reversed via the same map (`labelToName`) before that reply is persisted or returned, so the merchant still sees the real name. Only staff names are pseudonymized, not product names or business-level financials — those aren't personally identifying. Label assignment is positional per-request (ranked by revenue that call), not a stable per-person id stored anywhere, so if a ranking reshuffles between turns "Vendeur A" could refer to a different person turn-to-turn — an accepted tradeoff over adding a persistent name↔label table for what's meant to be a lightweight mitigation, not a guarantee.

**Period-over-period trend (added 2026-07-13):** Alpha previously only ever saw a flat 30-day snapshot — no way to say whether a number was actually good or bad without an implicit baseline. `get_reports_snapshot` is now called twice per request: once normally (current 30 days), once with `p_today` shifted back by `PERIOD_DAYS` — since the RPC internally computes `v_period_start := p_today - p_period_days`, passing a shifted `p_today` (with the same `p_period_days`) yields exactly the 30 days immediately before the current window, at zero extra migration cost (no SQL changes at all). `buildTrendBlock` diffs the two into `evolution_vs_periode_precedente` (`evolution_pct` + a `hausse`/`baisse`/`stable` label), computed server-side so Alpha never does its own percentage math — same reasoning as precomputed `produits_stock_bas`. Only period-bound flow metrics are compared (`revenue`, `net_profit`, `period_order_count`, or the vendeur-personal equivalents) — `credit_outstanding`/`cash_on_hand`/`stock_value` are live all-time balances the SQL computes identically regardless of `p_today`, so diffing them across the two calls would just compare a number to itself, not an actual trend. `previous === 0` reports `evolution_pct: null` with `tendance: 'hausse'` rather than a division-by-zero artifact — the prompt tells Alpha to read that as "nothing to compare last period" in words, never print the literal `null`.

**Lifetime totals, "depuis_le_debut" (added 2026-07-13):** requested as "give Alpha access to all their data." Taken literally that's not actually implementable or desirable — a business with two years of history could have thousands of rows, and stuffing per-transaction detail into every single message would blow the shared Groq/OpenAI token budget (see "Billing" above) and send far more to those third parties than necessary. What's cheap and useful instead: a third `get_reports_snapshot` call with `p_period_days: LIFETIME_PERIOD_DAYS` (3650 — no business on this platform is anywhere near that old, so it always captures true lifetime totals without needing to look up the business's real creation date). `buildLifetimeBlock` reduces that to a handful of aggregate numbers (`chiffre_affaires_total`, `profit_net_total`, `nombre_ventes_total`, or the vendeur-personal equivalents) under `depuis_le_debut` — same "aggregate, never raw rows" posture as the 30-day and trend blocks, just a wider window. The prompt tells Alpha to reach for this field specifically for "how's my business doing overall" questions, as distinct from the 30-day `chiffre_affaires` used for "how's this month going."

**Money-first framing:** `STATIC_INSTRUCTIONS` previously only said "cite real numbers instead of generalities." It now states Alpha's mission explicitly and in order — truth first (never invent a number outside "Données du commerce"), then: every answer must help the merchant make/keep more money, reasoned from *this* business's actual figures rather than generic small-business advice that may not apply here.

**Entry point**: a "Parler avec Alpha…" input styled as a fully rounded, detached pill (deliberately Google-search-bar-like — floating with margin on every side, not a flush full-width strip, no leading icon) docked to the bottom of the Accueil screen's content (`app/(app)/(tabs)/index.tsx`), not a header icon. No separate send button — submitting via the keyboard's own return/send key launches straight into `app/(app)/alpha` with the question pre-filled and auto-sent. The brand mark is a plain, uncolored "A" wordmark, used only as chrome (screen header, header shortcut icon, the "réfléchit…" status row) — never inside an input field itself.

**Support icon relocated to make room; a second Alpha entry point took its place.** The header's headphone/support icon (top-right of Accueil) was moved into the lateral `BusinessDrawer` footer, alongside the founder's existing "Service client" row — same destinations as before (founder → `support-inbox`, regular member → `support`), purely relocated. That freed header slot now hosts a persistent sparkle icon into `app/(app)/alpha` — a second, complementary entry point to the bottom pill bar: the bar is for typing a new question on impulse (incentivizing a first message), the header icon is for jumping straight back into the ongoing conversation to read history or continue it. Both lead to the same screen.

**Upsell UX**: when the quota is exhausted and the business has no AI access, the composer disables and an inline card (`PaywallScreen`'s `inline` prop) slides in above it — showing the specific question just typed, a subscribe button, and the honest wait-time alternative — rather than a route-level full-screen swap, so the still-visible conversation stays on screen at the exact moment of intent.

**Free vs. paid exhaustion are two distinct UI states (added 2026-07-13), not one.** `app/(app)/alpha/index.tsx` computes `freeQuotaExhausted` and `paidQuotaExhausted` separately from `quota`. A free-tier user who tries to send past their limit sees the upgrade popup above (they can act on it — upgrading unblocks them immediately). A **paid**-tier user at their 20/24h cap only ever sees a plain `waitCard` ("Vous pourrez reparler à Alpha dans Xh") with no subscribe CTA — showing an upgrade offer to someone already paying would be nonsensical and was explicitly called out as something to avoid. The two states share the same underlying `waitCard`, reached by different paths.

**The upgrade popup shows on every blocked free-tier send attempt, not throttled.** An earlier version of this capped the popup to once per 24h per business (via a local KV timestamp) and fell back to the plain `waitCard` in between, to avoid feeling like spam. That was reversed the same day: a free-tier user who's actively trying to send *should* see the offer every time, since that's the exact moment of intent — the "don't be a headache" instinct instead applies to a separate, still-unbuilt passive reminder (see below), not to this in-the-moment block. `freeQuotaExhausted` now goes straight to `setPendingQuestion(trimmed)` with no KV check in between; the `waitCard` is reachable only via `paidQuotaExhausted`, since a paying user is never shown the upgrade offer at all.

**Home-screen pre-filled auto-send used to bypass the quota check entirely (fixed 2026-07-13).** The "Demandez Alpha…" pill on Accueil navigates to `app/(app)/alpha` with the question pre-filled, auto-sent on mount. That auto-send effect used to call `sendMessage()` from the store directly instead of going through `handleSend`'s `freeQuotaExhausted`/`paidQuotaExhausted` gate — so an already-exhausted free-tier user submitting from the pill hit the raw `send_alpha_message` server rejection instead of the upgrade popup, while the in-chat composer (which does call `handleSend`) showed the popup correctly for the exact same state. Fixed by routing the auto-send through `handleSend` too. That alone wasn't sufficient: `quota` is fetched fire-and-forget inside `load()` (`stores/alpha.ts`), so it's still `null` on the very first render — evaluating the exhaustion check against a `null` quota always reads "not exhausted," race-defeating the fix. The auto-send effect now waits for `quota !== null` before deciding (re-running once the fetch resolves), with a 4s timeout fallback so a failed quota fetch (which leaves `quota` permanently `null`, since `fetchQuota` silently no-ops on error) can't strand the pre-filled question forever.

**Composer didn't account for being offline (fixed 2026-07-13).** Unlike support chat's `sendMessage` (KV-queued on a network error, `stores/supportChat.ts`), Alpha has no offline queue by design — a conversational reply needs a live round trip, so a message sent while offline is a real, immediate failure, not something to defer. The composer previously didn't reflect that: the `TextInput`/send button stayed fully enabled while offline, a doomed send cleared the typed text *before* the RPC even ran (so a network failure erased it, forcing a retype), and the store's `sendMessage` catch block never distinguished a network error from any other failure — no `offline` flag got set from a failed send (only from a failed initial `load()`), and the message fell through to `translateError`'s generic fallback instead of a clear "needs a connection" message. Fixed: `sendMessage` (`stores/alpha.ts`) now returns `Promise<boolean>`, sets `offline: true` and a dedicated French message on `isNetworkError`, and always strips the failed optimistic message; `handleSend` (`app/(app)/alpha/index.tsx`) only clears the composer when that boolean is `true`, so a failed send leaves the question in place for a plain retry. The composer itself (`TextInput` + send button) is now `editable={!offline}`/`disabled={offline}` with a dimmed style and an offline-specific placeholder, so the app doesn't invite a send it already knows will fail.

**A passive, non-annoying reminder for free-tier users who've hit their limit is still an open item, deliberately not built.** The product intent (stated separately from the blocking behavior above) is something like "remind them roughly every 24h, but not at night, not while the app is closed" — i.e. an in-app touchpoint timed to when they naturally reopen the app, not a push notification. No mechanism for this exists yet; don't confuse it with the popup-on-blocked-send behavior above, which is unthrottled and unrelated.

**Paywall copy dropped "Illimité" for "Alpha Pro" + a stated number (2026-07-13).** The tier used to be marketed as "Alpha Illimité" with the actual cap deliberately never stated, specifically so a stopgap quota change (`migration_v135.sql`) wouldn't need a copy update. Reversed on explicit product direction: a paying user discovering a silent cap after being sold "unlimited" is a worse trust break than stating a concrete, generous number up front — Hormozi's "specificity sells better than vague hype" applied literally. `PaywallScreen.tsx` now has a `PAID_DAILY_LIMIT = 20` constant (mirroring `send_alpha_message`'s `v_limit`) used in both the full-screen plan card ("20 conversations avec Alpha, chaque jour") and the inline upsell card copy — **this constant has to be bumped by hand alongside any future change to the SQL `v_limit`**, the tradeoff the old "never state a number" design was avoiding. The inline card also stopped repeating the user's just-typed question back to them (it's already visible in the chat transcript right above the card — showing it twice was clutter, not personalization) in favor of a plain outcome-focused headline, "Obtenez la réponse à votre question."

**CTA reads "Investir", not "Payer" or "S'abonner"** — deliberately framing the subscription as an investment in the business rather than a transactional purchase, consistent with the "one stockout avoided pays for months of this" ROI framing already used elsewhere on the paywall. Applied to both the full-screen and inline CTA buttons.

**Breathing CTA animation, on both the full-screen and inline cards.** A fabricated "was $299.99" price-reveal was prototyped and then deliberately dropped (compliance risk — Apple review and some jurisdictions treat a fake reference price as deceptive pricing) in favor of just the CTA breathing motion, kept on its own. The button starts a slow "breathing" scale pulse (`BREATH_HALF_CYCLE_MS = 2000`, ~4s per full cycle) after `BREATHE_START_DELAY_MS`, currently a flat **5s** (an initial reading-time-based estimate of ~18s — based on ~73 words of copy above the CTA at ~240 wpm — was overridden down to 5s on explicit product direction). The cadence itself is deliberately matched to a resting human breath rate (~12-16/min), not a fast attention-grabbing pulse, since a quicker rhythm reads as urgent/alarming rather than inviting. Originally scoped to the full-screen paywall only, then extended to the inline mid-chat card too — the inline card is the one users actually hit in the real quota-exhaustion flow, so scoping the animation out of it left the far more common path with no breathing CTA at all.

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

### Integration tests (`__tests__/integration/`)

The Jest suite in `__tests__/` mocks `supabase.rpc` entirely — it verifies the client calls the RPC with the right params, not that the SQL function itself is correct. `__tests__/integration/` closes that gap: it runs `submit_sale` / `cancel_sale` / `join_business` for real, against a local Supabase stack (`supabase start`), asserting on actual stock/payment/membership rows.

- **Local Postgres via Colima, not Docker Desktop** — this machine's macOS predates Sonoma, which Docker Desktop's cask requires. `brew install colima docker` gives a CLI-only Docker daemon that works fine for `supabase start`.
- **`[analytics]` is disabled in `supabase/config.toml`** — the vector/logflare log-shipping container bind-mounts the Docker socket in a way Colima's VM doesn't support (`mkdir ...docker.sock: operation not supported`). Not needed for tests, only the Studio log viewer.
- **`scripts/test-db-setup.js`** resets the `public` schema, re-grants the standard Supabase role privileges (`anon`/`authenticated`/`service_role` — lost when the schema is dropped and recreated, since `supabase start` doesn't redo cluster-init grants on an existing volume), then applies `db/schema.sql` followed by every `db/migration_v*.sql` **statement-by-statement** (via `scripts/lib/split-sql.js`, a dollar-quote-aware splitter) rather than one file per query. That granularity matters: Postgres treats a multi-statement simple-query message as a single implicit transaction, so if a file mixes an already-applied statement (schema.sql already has it — full-history replay from empty is something production itself never does) with a genuinely new one, running the file as one query rolls back the new statement too when the old one errors. This bit `migration_v90.sql` specifically — its new `message_type` column was reverted along with an unrelated already-applied policy statement further down the same file, which then made `migration_v91.sql` fail with "column message_type does not exist" one file later. Splitting per-statement fixed it.
- **`__tests__/integration/helpers.ts`** creates real throwaway auth users via the service-role key (`admin.auth.admin.createUser`), signs them in, and calls RPCs through the same `@supabase/supabase-js` client shape the app itself uses — so `auth.uid()` and RLS behave exactly as they do in production, not simulated.
- Run via `npm run test:db:start && npm run test:db:reset && npm run test:integration`. Deliberately excluded from `npm run check` (`jest.config.js`'s `testPathIgnorePatterns`) — it needs Docker running, so it stays a separate, opt-in gate (`jest.integration.config.js`) rather than blocking every fast local iteration.

### Email account recovery

`profiles.recovery_email` (TEXT UNIQUE, nullable) — set proactively by the user in Paramètres as a fallback if they lose their phone number.

**Linking flow (in-app, authenticated):** Paramètres → "Email de récupération" → enter email → `send-email-otp` sends 6-digit code via Resend → user enters code → `link-recovery-email` validates + saves to profile.

**Recovery flow (unauthenticated, on login screen):** "Numéro indisponible ?" → `/(welcome)/recuperation` → same email OTP → `recover-by-email` finds profile by `recovery_email`, generates magic link → `supabase.auth.verifyOtp({ token_hash, type: 'magiclink' })` → session. Identical magic-link pattern to `restore-phone-session`.

**OTP validation pattern in edge functions:** Always fetch the `email_verifications` row by `id` alone first (no status/expiry filters in the query), then check each condition separately with a distinct error message. Combining all filters into one query silently returns null for any failure reason, making debugging impossible.

### Critical: auth store `loading` flag

`(app)/_layout.tsx` renders `null` when `loading === true` — this unmounts the entire navigator, causing a white screen and redirect to `/(welcome)/`. **Never set `loading: true` from a store method called while the user is already inside the app.** 

Auth store has a separate `emailOtpLoading: boolean` flag for email OTP operations (`sendEmailOtp`, `linkRecoveryEmail`). Any future in-app async operations that need a loading state must use their own flag — not the global `loading`. The global `loading` is only for the initial session bootstrap.

**Offline vs. genuinely-invalid session on `initialize()`:** when `supabase.auth.getSession()` returns no session, the code checks `isAuthRetryableFetchError(sessionError)` before deciding what to do with an already-rendered cached session. A retryable fetch error means the device simply couldn't reach the server — the account's real validity is unknown, so the cached session keeps being trusted for offline use. Any other outcome (no error, or a non-retryable auth error like a revoked/invalid refresh token) means the account is genuinely no longer valid server-side, and the cached session must be cleared — it must not keep being trusted indefinitely just because it exists locally.

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
| `send-reconciliation-report` | Standalone reconciliation email — same checks as `send-report-email`'s `include_reconciliation` path, via the shared `supabase/functions/_shared/reconciliation.ts` module. No longer on a cron schedule as of v123; left deployed for manual/debug re-runs (e.g. re-checking right after a fix). Deployed with `--no-verify-jwt` (authenticates via its own `x-cron-secret` header instead of a Supabase JWT). See "Nightly reconciliation" below. |
| `send-report-email` | Sends the founder's one combined daily report (financial summary + reconciliation when `include_reconciliation: true`). Triggered by the "Patron — Rapport Quotidien" cloud routine at 6:00 AM ET. Shares `run_reconciliation()` / `run_display_checks()` / `refresh_reconciliation_run()` / `get_financial_snapshot()` logic with `send-reconciliation-report` via `_shared/reconciliation.ts` so the check logic lives in exactly one place. |
| `dispatch-notification` | Sends Expo push notifications for in-app events (e.g. `sale_completed`). Requires a Supabase JWT (`Authorization: Bearer`); the caller must be a member of `business_id`, **except** for the two partnership-handshake events (`partnership_request`, `partnership_accepted`), authorized via a `business_partnerships` row, and `support_reply`, authorized via the same `profiles.phone` founder check as `is_founder()`. A caller-supplied `target_user_ids` list is intersected against real members of the business server-side — a caller can never target an arbitrary user id. `support_message` recipient resolution bypasses `target_roles`/`target_user_ids` entirely and always routes to `get_founder_id()`, since the founder is never a member of the merchant's business. (Previously unauthenticated and unrestricted — any caller could push to any business/user; fixed alongside the PIN-lock work, no dedicated migration.) |
| `generate-support-draft` | Generates a founder-only AI draft reply for a support conversation (Groq, `llama-3.3-70b-versatile` — free tier, open-weight; see "Support chat" below). Triggered fire-and-forget after every merchant message and on-demand via the founder inbox's "Régénérer". Authorized as either a member of the conversation's business (the merchant-triggered path) or the founder (manual regenerate). Requires the `GROQ_API_KEY` edge function secret. |
| `revenuecat-webhook` | Updates `businesses.subscription_status`/`subscription_expires_at`/`payment_provider`/`revenuecat_customer_id` on RevenueCat subscription events (`INITIAL_PURCHASE`/`RENEWAL`/`UNCANCELLATION`/`PRODUCT_CHANGE`/`EXPIRATION`), and grants the "Inviter un ami" referral bonus on a business's first-ever activation. See "Native IAP paywall" above. Authenticates via a static `Authorization` header (RevenueCat webhooks aren't signature-based like Stripe's), checked against the `REVENUECAT_WEBHOOK_AUTH_HEADER` secret. |

### Nightly reconciliation (data integrity monitoring)

As of `migration_v123.sql`, there is **one** daily email, not two. The founder's
"Patron — Rapport Quotidien" cloud routine calls `send-report-email` at 6:00 AM ET
with `include_reconciliation: true`, which runs the full check sequence via the
shared `supabase/functions/_shared/reconciliation.ts` module:

1. `run_reconciliation()` — 68 checks across 14 domains (stock, sales,
   payments, COGS, expenses, credit, suppliers, purchase orders, products,
   monetary precision, members, cross-aggregates, temporal, referential
   integrity) + `run_display_checks()` (10 more, covering display-formula
   drift) — writing results to `reconciliation_runs` / `reconciliation_findings`.
2. `get_financial_snapshot()` — an independent revenue/COGS/expenses/net-profit
   recompute straight from the ledger, grouped by currency.
3. Everything is folded into the single combined report emailed via Resend to
   `FOUNDER_EMAIL`. Clean runs send a short "all clear" section; runs with
   findings list each one grouped by severity.

The old standalone `patron-nightly-reconciliation` `pg_cron` job (`0 2 * * *`
UTC → `send-reconciliation-report`) was unscheduled in v123 — that duplicated
coverage the combined report now provides. `send-reconciliation-report` itself
is still deployed (not deleted) for manual/debug re-runs, e.g. re-checking
right after a fix, and still authenticates via its own `x-cron-secret` /
`CRON_SECRET` check rather than a user JWT.

The cron secret lives in **Supabase Vault** (`patron_cron_secret`), pulled at
execution time via `vault.decrypted_secrets` — never stored as plaintext in
`cron.job`.

This system catches data corruption (e.g. an order total that doesn't match
its line items) and, since `run_display_checks()` was added, some
display-formula drift too — but consolidating the dashboard/reports/catalogue
screens' independently-computed "profit" formulas into one canonical backend
function remains a separate, tracked follow-up.

## Keeping this file current

This file is the main reason a fresh session can work on this codebase without re-discovering the same landmines. **Whenever you fix a bug or land a change whose root cause is not obvious from reading the resulting code** — a wrong assumption, a silent regression, a security gap, a platform gotcha, a rewrite that dropped a protection nobody noticed — add an entry before ending the task. Don't wait to be asked.

**What to add it for:**
- A DB migration with a real "why" (not just "adds column X") → a new row in the migration table.
- An app-code-only fix with a non-obvious cause (nothing to do with a migration) → a short note in the relevant architecture section, or a new subsection if it's a new system (see the Biometric-only lock section above for the shape: what it is, why it's structured that way, and the specific failure mode the current code avoids).
- A correction the user gives you mid-session about how this repo specifically works (not a general style preference — those belong in memory, not here) → fold it into the relevant section.

**What NOT to add:** anything a session could get by reading the current code — type shapes, prop lists, a function's current signature. Those entries go stale as the code moves and become actively misleading; the code itself is always the source of truth for "what," this file is for "why" and "what already went wrong here." If you're about to write a sentence that's just a paraphrase of the code you're looking at, stop.

**Format:** match the existing entries — migration table rows are one line: what changed, why, what broke without it. Architecture-section prose follows the pattern in "Biometric-only lock" / "Offline queue" / "Nightly reconciliation" above: state the mechanism, then the specific bug or race it was built to avoid. Keep it as dense as what's already here — this file earns its keep by being denser and more specific than generic docs, not by being long.

When migration numbers or table rows accumulate past what's practical to keep in full, compress older stretches the way the existing "(Note: migration_v58.sql through v75.sql... undocumented here)" line does, rather than deleting the history.
