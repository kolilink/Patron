# PostHog post-wizard report

The wizard has completed a deep integration of PostHog analytics into Patron. PostHog was already partially wired up (`lib/posthog.ts`, `lib/analytics.ts`, `PostHogProvider` in `app/_layout.tsx`, and several ad-hoc `trackEvent` calls). The wizard extended this with manual screen tracking on every route change, three new auth lifecycle events with full `identify`/`reset` calls, a product creation event, and two POS events — bringing total instrumented event coverage to 17 events across 7 files.

| Event | Description | File |
|---|---|---|
| `auth_login_screen_viewed` | User arrives on the login screen | `app/(welcome)/connexion.tsx` |
| `auth_phone_submitted` | User submits their phone number | `app/(welcome)/connexion.tsx` |
| `auth_otp_screen_shown` | OTP entry step displayed | `app/(welcome)/connexion.tsx` |
| `auth_otp_verified` | User enters correct OTP | `app/(welcome)/connexion.tsx` |
| `auth_failed` | OTP verification failed | `app/(welcome)/connexion.tsx` |
| `user_signed_up` | New user completes phone verification | `stores/auth.ts` |
| `user_logged_in` | Returning user restores session via OTP | `stores/auth.ts` |
| `user_logged_out` | User explicitly signs out | `stores/auth.ts` |
| `business_create_started` | User submits the create-business form | `app/(app)/onboarding/creer.tsx` |
| `business_created` | Business successfully created | `app/(app)/onboarding/creer.tsx` |
| `business_join_started` | User submits an invite code | `app/(app)/onboarding/rejoindre.tsx` |
| `business_joined` | User joins a business via invite code | `app/(app)/onboarding/rejoindre.tsx` |
| `product_created` | Admin/manager creates a new product | `stores/products.ts` |
| `sale_submitted` | Checkout completed online | `stores/sales.ts` |
| `sale_offline_queued` | Sale queued while device is offline | `stores/sales.ts` |
| `receipt_shared` | Merchant shares a sale receipt PNG | `app/(app)/(tabs)/vendre.tsx` |
| `credit_debt_added` | Quick credit debt recorded via Carnet tab | `app/(app)/(tabs)/vendre.tsx` |

Screen tracking is automatic — `posthog.screen(pathname)` fires on every Expo Router path change via `usePathname` in `app/_layout.tsx`. User identity is set with `posthog.identify()` + `posthog.group('business', …)` on login/signup and cleared with `posthog.reset()` on logout.

## Next steps

We've built a dashboard and five insights to monitor user behavior:

- [Analytics basics (wizard) — Dashboard](https://us.posthog.com/project/471957/dashboard/1716613)
- [New sign-ups over time](https://us.posthog.com/project/471957/insights/6TE3NpPw)
- [Daily sales volume](https://us.posthog.com/project/471957/insights/T36bRblh)
- [Auth funnel: phone to verified](https://us.posthog.com/project/471957/insights/5Su4eJNC)
- [Activation funnel: signed up to business ready](https://us.posthog.com/project/471957/insights/5aV0zLIW)
- [Receipt share rate vs sales](https://us.posthog.com/project/471957/insights/sakNy2v7)

## Verify before merging

- [ ] Run a full production build (`eas build`) and fix any lint or type errors introduced by the generated code. The wizard only verified TypeScript with `npx tsc --noEmit` on the files it touched.
- [ ] Run the test suite — call sites that were rewritten or instrumented may need updated mocks or fixtures.
- [ ] Add `EXPO_PUBLIC_POSTHOG_KEY` and `EXPO_PUBLIC_POSTHOG_HOST` to `.env.example` and any CI/EAS environment secrets so collaborators and build pipelines know what to set.
- [ ] Confirm the returning-visitor path also calls `identify` — `restorePhoneSession` now identifies the user, but verify that `loginWithBiometric` (which re-uses a stored refresh token without going through the OTP flow) also surfaces to PostHog with the correct distinct ID. The `identifyUser` call in `app/_layout.tsx` fires on every session change, so biometric login is covered via the session effect, but double-check in staging.

### Agent skill

We've left an agent skill folder in your project at `.claude/skills/integration-expo/`. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.
