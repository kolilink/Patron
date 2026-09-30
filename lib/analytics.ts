import { posthog } from './posthog';
import { isNetworkError } from '@/lib/sync';
import type { AppSession } from '@/src/types';

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

export function trackEvent(
  event: string,
  businessId: string | null,
  userId: string | null,
  metadata?: Record<string, unknown>,
): void {
  try {
    posthog.capture(event, {
      ...(businessId ? { business_id: businessId } : {}),
      ...(userId     ? { user_id:     userId     } : {}),
      ...metadata,
    });
    if (__DEV__) console.log('[analytics]', event, metadata);
  } catch {
    // Silently drop — analytics must never affect merchant experience
  }
}

export function identifyUser(session: AppSession): void {
  try {
    const biz = session.activeBusiness;
    posthog.identify(session.user.id, {
      name:                session.user.name,
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
        name:                 biz.name,
        currency:             biz.currency,
        subscription_status:  biz.subscription_status,
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
}
