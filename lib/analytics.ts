import { posthog } from './posthog';
import type { AppSession } from '@/src/types';

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
