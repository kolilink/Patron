# Patron — measurement layer

What the founder KPI screen measures, where each number comes from, and how test traffic is kept out.
Source of truth: the measurement spec (`patron-measurement/measurement-spec.md`, reproduced at the end of this file).
Shipped in `db/migration_v209.sql` plus the client changes on the same branch.

## 1. The integrity rule: `is_test`

A business is excluded from **every** founder number when any of these is true:

| Rule | Where it's set |
|---|---|
| `businesses.is_test` | Founder long-press on a call-list row → `set_business_is_test()`; or the trigger below |
| creator's `profiles.is_test` | Backfilled + trigger for the founder phone (+1 267-242-1843) |
| creator never verified a phone | demo sessions, abandoned anonymous sign-ups (same rule as v175/v182) |

- A business created by a test profile is test from its first row (`businesses_inherit_is_test` trigger).
- A profile whose phone becomes the founder's is test (`profiles_mark_founder_test` trigger).
- To flag a team member's account by hand (SQL editor): `UPDATE profiles SET is_test = true WHERE phone = '+224…';` then `UPDATE businesses SET is_test = true WHERE created_by = '<that id>';`

On the device, `lib/analytics.ts` stamps `is_test` on every event:
the founder phone, a flagged profile or business, or demo mode → `true`.
With no session (welcome/OTP screens) it uses the last value seen on that phone, so team phones stay test before login.
A real merchant session always overrides that, so a merchant's events are never marked test because a team member once used the phone.

## 2. Event taxonomy (PostHog)

Every event carries `business_id` (null before a business exists) and `is_test`, both explicitly and as PostHog super properties (so autocaptured `$screen` and app-lifecycle events carry them too).
No names, phone numbers, or message contents — enforced by `__tests__/analytics-event-properties.test.ts`, which scans every `trackEvent` call site.

| Event | Properties | Fired from |
|---|---|---|
| `app_installed` | platform | first open, `lib/funnel.ts` |
| `app_opened` | source: cold_start / foreground | `app/_layout.tsx`; `app/(app)/_layout.tsx` after ≥10 min in background |
| `signup_started` | — | phone submitted, `(welcome)/creer.tsx` |
| `otp_sent` | flow: signup / login / join / milestone | the four OTP screens |
| `otp_verified` | flow | same |
| `otp_failed` | flow, reason | same |
| `commerce_created` | currency, business_type | `stores/auth.ts` (was `business_created`) |
| `onboarding_completed` | outcome: hero_saved / hero_skipped / joined | `FirstRunHeroOverlay` (once per business), `stores/auth.ts` join |
| `first_value_action` | kind: sale / credit | `stores/sales.ts`, admin/manager only, once per business per device |
| `sale_recorded` | source: cart / quick, … | `stores/sales.ts` (was `sale_submitted`, `quick_sale_queued`) |
| `credit_recorded` | source: cart / quick, … | `stores/sales.ts` (was `credit_debt_queued`; a cart sold on credit) |
| `repayment_recorded` | scope: sale / client, fully_settled | `stores/ventes.ts` (was `debt_payment_recorded`; per-sale payments are new) |
| `product_added` | … | `stores/products.ts` (was `product_created`) |
| `invite_sent` | source | share sheet (was `invite_shared`) |
| `invite_opened` | source: deep_link / deferred | `app/invite.tsx`, `lib/inviteLink.ts` |
| `invite_signup_completed` | inviter_id | `stores/inviter.ts` |
| `alpha_queried` | length | `stores/alpha.ts` |
| `post_created` | category | `stores/market.ts` |

Kept unchanged, not in the spec: `auth_*` screen/submit events, `business_*_started`, `business_joined`, `business_deleted`, `user_*`, `tab_viewed`, `quick_capture_*`, `receipt_shared`, `reception_confirmed`, `first_run_hero_*` (the debt amount was removed — now `has_debt: true`), `startup_step_completed`, the sync-health events.

PII removed in the same pass:
- `identifyUser` no longer sends the person's name, and the business group no longer sends the business name.
- `posthog.screen` used to send the concrete path and every route param (e.g. a client's name in `/clients/[name]`); it now sends the route template only (`/(app)/clients/[name]`).

Offline / low data: the PostHog React Native SDK already queues events on the device and sends them in batches.

## 3. Install and OTP: why a server table, not PostHog or `phone_verifications`

The spec forbids the founder screen depending on the PostHog query API, and the business tables can't see install or OTP.
`phone_verifications` doesn't fit either: login rows are deleted after use, abandoned logins look like sign-ups, and nothing links a row to an install.

So the device records those steps itself in `funnel_devices` (one row per install, random device id, no PII) through `record_funnel_step()`.
`lib/funnel.ts` queues each step on the phone and retries until it lands.

| Step | When | Effect |
|---|---|---|
| `installed` | first open | earliest timestamp kept |
| `otp_sent` | sign-up flow only | first timestamp kept |
| `otp_verified` | sign-up flow only | links the device to the user who will own the commerce |
| `seen` | any test session on this phone | marks the device test, unless it's already linked to another (real) user |

Commerce and first value are then read from `businesses` / `sale_orders` through that link.
**Known limit:** `record_funnel_step` is callable without a session (install happens before one exists), so a scripted caller could inflate install counts. Acceptable at this scale; a per-IP cap is the fix if it ever matters.
**Known limit:** the funnel only fills from devices running this version — older installs never sent `installed`.

For invites, the opposite choice: `create_consumer_invite()` used to DELETE expired, unused links, which made "invites created" under-count.
They're now marked `status = 'expired'` and hidden from `list_my_consumer_invites()`, so the merchant UI is unchanged.

## 4. Server metrics (`db/migration_v209.sql`)

All views are revoked from `anon`/`authenticated` — readable only through the founder-gated RPCs or the SQL editor.

| Object | What it is |
|---|---|
| `kpi_businesses` | one row per real business: owner, `is_referred`, `first_value_at` (first `paye`/`credit` sale) |
| `kpi_core_actions` | sale or credit entry, repayment (payment made after its order), product added |
| `kpi_business_activity` | `kpi_businesses` + last action, actions and active days in the last 7 days |
| `get_founder_kpis()` | blocks 1–5 as one JSON object |
| `get_founder_call_lists()` | block 7 |
| `set_business_is_test()` | founder flags a business as test |

Block definitions:

1. **North Star** — businesses with ≥ 1 core action in a trailing 7-day window, current week plus the 7 before it.
2. **Funnel** — devices first opened in the last 30 days: installed → code sent → code verified → commerce → first value, with % of previous step and the median time between steps.
3. **Activation + TTFV** — % of businesses created in the last 30 days with a first value; median TTFV from install (`funnel_devices`) and from commerce creation; % with first value in < 24 h.
4. **Retention** — activated businesses, relative to their first value: W1 = a core action in days 7–13, W4 = days 28–34. Only businesses whose window has fully elapsed count.
5. **Referral, 30 days** — share rate (active businesses with a member who created an invite link ÷ active businesses), referral conversion (links used ÷ links created), K-factor (referred sign-ups ÷ active businesses), referred quality (activation of referred vs organic businesses, last 90 days). "Referred" = `referred_by_business_id` set, or the owner redeemed a consumer invite.
6. **Frein actuel** — computed on the device in `src/utils/founderKpis.ts`: for each stage with ≥ 5 units, (relative gap to target) × leverage; the biggest wins and names one next action. Targets and leverage weights are the `TARGETS` constant there.
7. **Call lists** — see below.

## 5. WhatsApp call lists (saved queries)

Runnable as-is in the SQL editor:

```sql
-- New this week → welcome
SELECT * FROM call_list_welcome;
-- Activated, then silent 7+ days → interview
SELECT * FROM call_list_interview;
-- Core action on 4+ of the last 7 days → referral ask
SELECT * FROM call_list_referral;
```

On the screen, tapping a row opens WhatsApp to the owner's number with a ready-to-send French message; a long press marks the business as test.

## 6. Tests

- `__tests__/integration/founder-kpis.integration.test.ts` (real local Postgres). Run it alone, so other suites' writes can't touch the snapshots: `npx jest --config jest.integration.config.js founder-kpis --runInBand`.
  - Founder-only access: a vendeur, the admin of another business and an anonymous client are refused on every founder RPC; nobody can read the views directly.
  - Test traffic changes nothing: the founder's own shop, a flagged team shop and a test device move none of the numbers, while the same activity on a real shop does.
  - Call-list membership, the device-flag rules, and expired invites being kept.
- `__tests__/analytics-event-properties.test.ts`: `business_id`/`is_test` on every event, the sticky device flag, and no PII.
- `__tests__/founder-kpis.test.ts`: derived numbers and the frein rule.

## 7. Spec (verbatim)

See `~/workspace/your_files/patron-measurement/measurement-spec.md`; key points:
unit of analysis is the commerce; `is_test` on every event and filtered from every KPI; zero PII in events; the founder screen reads Supabase, not PostHog; founder-only access; targets are directional at n < 100, W1 60 % is a stretch.
