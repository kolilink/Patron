# Invite Journey — Phase 0 Read-Only Audit

> Produced read-only (no code changed). Covers (a) home/header structure, (b) exact
> header layout order, (c) existing invite-code server behavior vs. the 10 invariants.

## 1. Home / header map

File: [`app/(app)/(tabs)/index.tsx`](app/(app)/(tabs)/index.tsx:653)

| Control | Tap → destination | Reachable elsewhere? |
|---|---|---|
| Hamburger `≡` icon | opens [`BusinessDrawer`](src/components/BusinessDrawer.tsx:64) (business picker "Mes commerces") | Header only |
| Business name (left) | same picker | Header only |
| **"A" (AI) button** | `/(app)/alpha` | **Header only** — in-code comment confirms the "A" is the sole dashboard entry point into Alpha (floating pill removed 2026-09-02) |
| **Discussions button** (`chatbubbles-outline`) | `/(app)/discussions` | **Header only** — no `discussions` tab in the floating tab bar, no drawer entry |

**Conclusion on moving AI:** relocating the "A" control into the hamburger drawer
strands **nothing** — Alpha's single entry point moves with it. Discussions is a
separate header icon and is NOT being moved (it stays at top-right). Neither Alpha
nor Discussions exists in the tab bar ([`app/(app)/(tabs)/_layout.tsx`](app/(app)/(tabs)/_layout.tsx:191))
nor in the drawer footer ([`src/components/BusinessDrawer.tsx`](src/components/BusinessDrawer.tsx:279)).

## 2. Exact header layout order

Current left → right within [`styles.header`](app/(app)/(tabs)/index.tsx:654):

1. **Left cluster** (`flexDirection: row, alignItems: center`):
   - `Pressable` hamburger (`Ionicons name="menu"`, `accessibilityLabel="Changer de commerce"`)
   - `Text variant="h4"` business name (`marginLeft: 12`)
2. **Right cluster** (`flexDirection: row, alignItems: center, gap: spacing[2]`):
   - `Pressable` → `/(app)/alpha` (boxed "A" glyph)
   - `Pressable` → `/(app)/discussions` (`chatbubbles-outline` + unread badge)

`header` style: `{ paddingBottom: spacing[2], flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }`.

**Inviter pill placement:** adding it as the last child of the right cluster (at the
right edge) shifts nothing — the two clusters are already `space-between`. Moving
the "A" into the drawer only removes the first right-cluster child; the pill slots
into the freed position without touching the Discussions button or its badge.

## 3. Invite-code server behavior audit

Three distinct existing systems (all separate from the new consumer "Inviter" journey):

- **Team member invites** — `invite_codes` table ([`db/schema.sql`](db/schema.sql:138)) + `join_business()` RPC ([`db/migration_v197.sql`](db/migration_v197.sql:35)).
- **Partner invites (Amis)** — `partner_invite_codes` table + RPCs ([`db/migration_v95.sql`](db/migration_v95.sql:52)).
- **Referral bonus** — `businesses.referral_code` + `resolve_referral_code()` ([`db/migration_v130.sql`](db/migration_v130.sql:61)).

| # | Invariant | Status | Evidence |
|---|---|---|---|
| 1 | Cryptographically secure code generation | **PARTIAL** | Team: client-side CSPRNG via expo-crypto `getRandomValues` in [`generateCode()`](stores/equipe.ts:36) (8 chars × 32-char alphabet ≈ 40 bits). Partner: server-side `gen_random_bytes(4)` hex = 8 hex chars ≈ 32 bits. No 128-bit+ token anywhere. |
| 2 | Keyed-digest (HMAC) storage, never raw | **MISSING** | Both tables store raw plaintext: `invite_codes.code text` and `partner_invite_codes.code text`. |
| 3 | Server-enforced 24h expiry | **HAVE** | `join_business()` checks `expires_at <= now()`; `partner_invite_codes.expires_at` defaults to `now() + interval '24 hours'` and is checked in `send_partnership_request()`. Caveat: team `invite_codes.expires_at` is nullable with no server default (client sets 24h). |
| 4 | Atomic single-use consumption | **HAVE** | `join_business()` `UPDATE … SET uses = uses + 1` after `uses >= max_uses` check inside a SECURITY DEFINER transaction; every real code has `max_uses = 1`. Partner path sets `used_at` once, checked before consume. |
| 5 | Redemption rate limiting | **HAVE** | `invite_attempts` — 5 attempts / 10 min enforced in `join_business()`. |
| 6 | One generic error for invalid/expired/revoked/reused | **MISSING** | Distinct messages per failure: "Ce code a expiré…", "Ce code a déjà été utilisé…", "Limite de 3 boutiques…", "Cette boutique a déjà un gérant…", "Vous êtes déjà membre…". Partner path also distinct ("Code invalide" / "déjà utilisé" / "expiré"). |
| 7 | Code bound to inviter | **HAVE** | Team: `created_by uuid FK auth.users` + `business_id FK`. Partner: `business_id FK`. |
| 8 | Redemption audit log (who/when) | **PARTIAL** | `redeemed_by` + `redeemed_at` columns on `invite_codes` (most-recent-only; no history table — see [`db/migration_v194.sql`](db/migration_v194.sql:8)). Partner: `used_at` + `used_by_business_id` (single-use so effectively complete). |
| 9 | Instant revocation of unused codes | **HAVE** | Team: `revokeCode()` DELETEs by id ([`stores/equipe.ts`](stores/equipe.ts:263)). Partner: `regenerate_invite_code()` expires all unused + creates fresh. |
| 10 | Founder revoke-all | **MISSING** | No RPC/UI to revoke all unused codes across businesses. |

## 4. Blockers

- **B1 — Smart-link / landing-page hosting (blocks Phase 1 message format + Phases 2–4).**
  This repo's only web hosting is **static GitHub Pages** at `patron.kolilink.com`
  ([`.github/workflows/static.yml`](.github/workflows/static.yml:1) uploads the whole
  repo). Static pages cannot render a **dynamic per-sender og:title/og:image**. Dynamic
  server-side HTML **is** available via Supabase Edge Functions (`djomi-checkout` already
  returns full HTML). Decision needed on where the smart link + landing page live.
- **B2 — No Universal Links / App Links config.** [`app.json`](app.json:21) has no
  `associatedDomains` (iOS) and no Android `intentFilters`; no AASA/assetlinks.json.
  "App installed → open directly" (Phase 2) requires these native configs + a hosted
  AASA/assetlinks + a native EAS rebuild. Not JS-only.
- **B3 — Play Install Referrer API** (deferred deep link on Android) needs a native
  module / `expo` install-referrer equivalent + rebuild.
- **B4 — DB test target.** Per project doctrine, any DB test must run against a proven
  TEST Postgres database (never production); if ambiguous, stop and report before running.
- **Non-blocker:** store listing URLs stay exactly as given (no rename).
