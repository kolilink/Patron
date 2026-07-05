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
