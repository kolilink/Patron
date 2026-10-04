import { posthog } from './posthog';
import { isNetworkError } from '@/lib/sync';
import type { AppSession } from '@/src/types';
import { getKV, setKV } from '@/lib/db';
import { isFounderPhone } from '@/src/utils/founder';

export type AuthErrorReason =
  | 'invalid_code'
  | 'expired'
  | 'locked_out'
  | 'rate_limited'
  | 'invalid_phone'
  | 'send_failed'
  | 'phone_exists'
  | 'phone_not_found'
  | 'network_error'
  | 'unknown';

// Maps the raw string stores/auth.ts's error state already holds (thrown
// straight from create-phone-verification/verify-phone-code) to a stable
// reason bucket for auth_failed events. Ordered most-specific-first since
// e.g. "Trop de tentatives incorrectes" also contains "Trop de tentatives".
const AUTH_ERROR_PATTERNS: ReadonlyArray<readonly [string, AuthErrorReason]> = [
  ['Code incorrect',                 'invalid_code'],
  ['Code expiré',                    'expired'],
  ['Trop de tentatives incorrectes', 'locked_out'],
  ['Trop de tentatives',             'rate_limited'],
  ['Numéro de téléphone invalide',   'invalid_phone'],
  ["Impossible d'envoyer le code",   'send_failed'],
  ['PHONE_EXISTS',                   'phone_exists'],
  ['PHONE_NOT_FOUND',                'phone_not_found'],
];

export function classifyAuthError(raw: string | null | undefined): AuthErrorReason {
  if (!raw) return 'unknown';
  if (isNetworkError(raw)) return 'network_error';
  for (const [needle, reason] of AUTH_ERROR_PATTERNS) {
    if (raw.includes(needle)) return reason;
  }
  return 'unknown';
}

// ─── Event context: business_id + is_test on EVERY event ──────────────────
//
// The measurement spec (docs/measurement.md) requires both properties on
// every event so team/test traffic can be filtered out of every number.
// They are applied two ways: explicitly by trackEvent(), and as PostHog
// super properties (register) so autocaptured events ($screen, app
// lifecycle) carry them too.
//
// is_test is true when the session is the founder's (phone match) or a
// profile/business flagged is_test server-side. With no
// session (pre-login), it falls back to the last value seen on THIS device,
// so a team phone stays test on the welcome/OTP screens. A real session
// always overrides that sticky value — a merchant's own events are never
// marked test just because a team member once used the phone.

const STICKY_TEST_KEY = 'analytics_device_is_test';

type AnalyticsContext = { businessId: string | null; isTest: boolean; hasSession: boolean };
let context: AnalyticsContext = { businessId: null, isTest: false, hasSession: false };
let deviceIsTest = false;

export function isTestSession(session: AppSession | null | undefined): boolean {
  if (!session) return false;
  return isFounderPhone(session.user.phone)
    || !!session.user.is_test
    || !!session.activeBusiness?.is_test;
}

/** Current is_test value, as stamped on events. */
export function analyticsIsTest(): boolean {
  return context.hasSession ? context.isTest : deviceIsTest;
}

function registerSuperProperties(): void {
  try {
    void posthog.register({ business_id: context.businessId, is_test: analyticsIsTest() });
  } catch {
    // Silently drop
  }
}

/** Restores the device's sticky test flag at cold start (after openDb). */
export async function loadDeviceTestFlag(): Promise<void> {
  try {
    deviceIsTest = (await getKV(STICKY_TEST_KEY)) === '1';
    registerSuperProperties();
  } catch {
    // Silently drop
  }
}

export function setAnalyticsSession(session: AppSession | null): void {
  const isTest = isTestSession(session);
  context = {
    businessId: session?.activeBusiness?.id ?? null,
    isTest,
    hasSession: !!session,
  };
  if (isTest && !deviceIsTest) {
    deviceIsTest = true;
    void setKV(STICKY_TEST_KEY, '1').catch(() => {});
  }
  registerSuperProperties();
}

/**
 * Never pass names, phone numbers, amounts tied to a person, or any other
 * PII in metadata — events leave the device for a third party.
 */
export function trackEvent(
  event: string,
  businessId: string | null,
  userId: string | null,
  metadata?: Record<string, unknown>,
): void {
  try {
    posthog.capture(event, {
      ...metadata,
      business_id: businessId ?? context.businessId ?? null,
      is_test:     analyticsIsTest(),
      ...(userId ? { user_id: userId } : {}),
    });
    if (__DEV__) console.log('[analytics]', event, metadata);
  } catch {
    // Silently drop — analytics must never affect merchant experience
  }
}

// No names here (spec §0: zero PII) — the person and the business are
// identified by their ids only.
export function identifyUser(session: AppSession): void {
  setAnalyticsSession(session);
  try {
    const biz = session.activeBusiness;
    posthog.identify(session.user.id, {
      is_test: analyticsIsTest(),
      ...(session.activeMembership?.role ? { role: session.activeMembership.role } : {}),
      ...(biz ? {
        business_id:         biz.id,
        business_currency:   biz.currency,
        subscription_status: biz.subscription_status,
        ...(biz.type ? { business_type: biz.type } : {}),
      } : {}),
    });
    if (biz) {
      posthog.group('business', biz.id, {
        currency:            biz.currency,
        subscription_status: biz.subscription_status,
        is_test:             analyticsIsTest(),
      });
    }
  } catch {
    // Silently drop
  }
}

export function resetAnalytics(): void {
  try {
    posthog.reset();
  } catch {
    // Silently drop
  }
  setAnalyticsSession(null);
}
