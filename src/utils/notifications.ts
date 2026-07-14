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

export async function deleteDeviceToken(
  token: string,
  platform: 'ios' | 'android',
): Promise<void> {
  try {
    await supabase.functions.invoke('register-device-token', {
      body: { token, platform, action: 'delete' },
    });
  } catch {
    // Silent
  }
}
