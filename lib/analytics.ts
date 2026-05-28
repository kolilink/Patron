import { supabase } from '@/lib/supabase';

export function trackEvent(
  event: string,
  businessId: string | null,
  userId: string | null,
  metadata?: Record<string, unknown>,
): void {
  void (async () => {
    try {
      await supabase.from('analytics_events').insert({
        event,
        business_id: businessId || null,
        user_id: userId || null,
        metadata: metadata ?? null,
      });
      if (__DEV__) console.log('[analytics]', event, metadata);
    } catch {
      // Silently drop — analytics must never affect merchant experience
    }
  })();
}
