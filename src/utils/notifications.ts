import { supabase } from '@/lib/supabase';

interface NotifyEventParams {
  businessId: string;
  eventType: string;
  payload: Record<string, unknown>;
  targetRoles?: string[];
  targetUserIds?: string[];
  excludeUserId?: string;
}

// Fire-and-forget — never awaited, never throws, never blocks a store action.
export function notifyEvent(params: NotifyEventParams): void {
  void supabase.functions.invoke('dispatch-notification', {
    body: {
      business_id: params.businessId,
      event_type: params.eventType,
      payload: params.payload,
      target_roles: params.targetRoles,
      target_user_ids: params.targetUserIds,
      exclude_user_id: params.excludeUserId,
    },
  });
}

// Seller display-name resolution for the sale_completed notification body —
// mirrors stores/ventes.ts's resolution order (membership display_name
// override, set by a manager for a local/nickname, then profile.name) so the
// online submit path and the offline-queue replay path (lib/sync.ts) never
// disagree on what name a seller's sale shows. Returns '' when the seller has
// no name at all — the caller passes that through so the edge function can
// reframe the sentence product-first ("2 Coca ont été vendus pour …") instead
// of printing a generic "Vendeur" placeholder.
export async function resolveSellerDisplayName(businessId: string, sellerId: string): Promise<string> {
  try {
    const [{ data: membership }, { data: profile }] = await Promise.all([
      supabase.from('memberships').select('display_name').eq('business_id', businessId).eq('user_id', sellerId).maybeSingle(),
      supabase.from('profiles').select('name').eq('id', sellerId).maybeSingle(),
    ]);
    return (membership as { display_name: string | null } | null)?.display_name
      || (profile as { name: string | null } | null)?.name
      || '';
  } catch {
    return '';
  }
}

export async function registerDeviceToken(
  token: string | null,
  platform: 'ios' | 'android',
): Promise<void> {
  try {
    await supabase.functions.invoke('register-device-token', {
      body: { token, platform },
    });
  } catch {
    // Silent — notification registration never surfaces to the user
  }
}

// Resets the server-tracked unread counter (profiles.unread_notification_count)
// that dispatch-notification stamps into the next push's badge field — call
// this whenever the user actually opens/foregrounds the app, alongside the
// local Notifications.setBadgeCountAsync(0). Without it, the OS icon badge
// resets locally but the server keeps counting from wherever it left off,
// so the next background push shows a stale, too-high number.
export async function resetUnreadBadge(userId: string): Promise<void> {
  try {
    await supabase.from('profiles').update({ unread_notification_count: 0 }).eq('id', userId);
  } catch {
    // Best-effort — a failed reset just means the next push's badge number is briefly stale
  }
}
