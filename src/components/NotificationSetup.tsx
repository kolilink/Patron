import { useEffect, useRef } from 'react';
import { AppState, AppStateStatus, Platform } from 'react-native';
import type * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { colors } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useExpensesStore } from '@/stores/expenses';
import { useChatStore } from '@/stores/chat';
import { registerDeviceToken, resetUnreadBadge } from '@/src/utils/notifications';

const EAS_PROJECT_ID = '9cd0ec2b-0dc9-49f3-ba97-999bb31a0252';

// expo-notifications' native module only exists once the app has been rebuilt
// with this dependency linked in — requiring it eagerly would crash older
// binaries that receive this code via an OTA update (this component mounts
// unconditionally for every logged-in user). Load it lazily so they no-op.
function getNotifications(): typeof Notifications | null {
  try {
    return require('expo-notifications');
  } catch {
    return null;
  }
}

// ─── Android notification channels ──────────────────────────────────────────
// Channels are created once. Sound and importance are permanent per channel.
// patron_default: soft sound, medium importance — informational events
// patron_urgent:  sharp double sound, high importance — events needing action
async function ensureAndroidChannels(N: typeof Notifications): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Promise.all([
    N.setNotificationChannelAsync('patron_default', {
      name: 'Patron',
      importance: N.AndroidImportance.DEFAULT,
      sound: 'patron_default.wav',
      vibrationPattern: [0, 180],
      lightColor: colors.primary[500],
    }),
    N.setNotificationChannelAsync('patron_urgent', {
      name: 'Patron — Urgent',
      importance: N.AndroidImportance.HIGH,
      sound: 'patron_urgent.wav',
      vibrationPattern: [0, 200, 100, 200],
      lightColor: colors.warning[500],
    }),
  ]);
}

// ─── iOS notification categories (action buttons) ────────────────────────────
// expense_pending: Valider / Refuser inline from lock screen
// chat_incoming:   Répondre inline text input — type and send without opening app
async function registerCategories(N: typeof Notifications): Promise<void> {
  await Promise.all([
    N.setNotificationCategoryAsync('expense_pending', [
      {
        identifier: 'approve',
        buttonTitle: 'Valider',
        options: { opensAppToForeground: true },
      },
      {
        identifier: 'reject',
        buttonTitle: 'Refuser',
        options: { isDestructive: true, opensAppToForeground: false },
      },
    ]),
    N.setNotificationCategoryAsync('chat_incoming', [
      {
        identifier: 'reply',
        buttonTitle: 'Répondre',
        textInput: {
          submitButtonTitle: 'Envoyer',
          placeholder: 'Message…',
        },
        options: { opensAppToForeground: false },
      },
    ]),
  ]);
}

// Non-invasive — reads current status only, never shows the OS dialog.
// Used by NotificationPrimer to decide whether it's even worth showing
// itself (already granted, or already hard-denied with no way to re-ask).
export interface NotifPermState {
  granted: boolean;
  // false once the user has genuinely denied the real OS prompt (iOS) or
  // Android has decided not to re-prompt — at that point the only path back
  // is Settings, so NotificationPrimer must not show its "Activer" ask again.
  canAskAgain: boolean;
}

export async function checkNotificationPermission(): Promise<NotifPermState | null> {
  const N = getNotifications();
  if (!N) return null;
  try {
    const perms = await N.getPermissionsAsync();
    const p = perms as unknown as { granted?: boolean; canAskAgain?: boolean };
    return { granted: !!p.granted, canAskAgain: p.canAskAgain !== false };
  } catch {
    return null;
  }
}

// The only function in this file that actually shows the real OS permission
// dialog. iOS only ever shows it once per install — a denial makes every
// future call here resolve immediately with no UI, which is exactly why
// this must only ever be invoked from a deliberate, primed moment
// (NotificationPrimer's "Activer les notifications" button), never
// automatically on mount/foreground. Returns whether it ended up granted.
export async function requestNotificationPermission(): Promise<boolean> {
  const N = getNotifications();
  if (!N) return false;
  try {
    const perms = await N.requestPermissionsAsync();
    if (!(perms as unknown as { granted?: boolean }).granted) return false;
    await Promise.all([ensureAndroidChannels(N), registerCategories(N)]);
    const tokenResult = await N.getExpoPushTokenAsync({ projectId: EAS_PROJECT_ID });
    await registerDeviceToken(tokenResult.data, Platform.OS as 'ios' | 'android');
    return true;
  } catch {
    return false;
  }
}

// Mount + foreground refresh only — registers channels/categories/token for
// a user who's ALREADY granted permission (e.g. a returning user, or right
// after NotificationPrimer's own request succeeded and token needs
// (re-)registering). Deliberately never calls requestPermissionsAsync()
// itself anymore — that used to fire the raw OS dialog unconditionally the
// instant this component mounted, which is the very first moment after
// login, with zero context. NotificationPrimer (rendered from
// app/(app)/_layout.tsx, after onboarding, with an explained reason) is now
// the only place that ever asks.
async function setupAndRegister(): Promise<void> {
  const session = useAuthStore.getState().session;
  if (!session || session.isDemoMode) return;

  const N = getNotifications();
  if (!N) return;

  try {
    const perms = await N.getPermissionsAsync();
    if (!(perms as unknown as { granted?: boolean }).granted) return;

    await Promise.all([
      ensureAndroidChannels(N),
      registerCategories(N),
    ]);

    const tokenResult = await N.getExpoPushTokenAsync({ projectId: EAS_PROJECT_ID });
    await registerDeviceToken(tokenResult.data, Platform.OS as 'ios' | 'android');
  } catch {
    // Silent — notification setup never surfaces to the user
  }
}

// Every push's data payload carries business_id (dispatch-notification always
// stamps it — supabase/functions/dispatch-notification/index.ts) — the
// business the notification is ABOUT, which isn't necessarily the caller's
// currently active one for a multi-business user. Without this, tapping a
// notification lands on the right screen while every store on it still
// serves whichever business happened to be active before the tap. Same
// selectBusiness() BusinessDrawer's manual switcher already uses
// (stores/auth.ts) — just applied here too, once, ahead of every branch
// below rather than duplicated per-branch. Silently no-ops if businessId
// isn't one of the caller's own memberships (not a member, or a
// founder-only event like support_message where there's nothing to switch
// into — support-inbox isn't business-scoped anyway) — selectBusiness()
// already guards that.
function ensureActiveBusiness(businessId: string | undefined): void {
  if (!businessId) return;
  const { session, selectBusiness } = useAuthStore.getState();
  if (!session || session.activeBusiness?.id === businessId) return;
  selectBusiness(businessId);
}

// ─── Notification action handler ─────────────────────────────────────────────
async function handleResponse(response: Notifications.NotificationResponse): Promise<void> {
  const N = getNotifications();
  if (!N) return;

  const { actionIdentifier, notification } = response;
  const data = notification.request.content.data as Record<string, unknown>;
  ensureActiveBusiness(data?.business_id as string | undefined);

  // Default tap — navigate to the right screen
  if (actionIdentifier === N.DEFAULT_ACTION_IDENTIFIER) {
    const route = data?.route as string | undefined;
    if (route) {
      try { router.push(route as never); } catch { /* not yet mounted */ }
    }
    return;
  }

  // ── Expense: Valider ────────────────────────────────────────────────────
  if (actionIdentifier === 'approve') {
    const expenseId = data.expense_id as string | undefined;
    const session   = useAuthStore.getState().session;
    if (expenseId && session) {
      await useExpensesStore.getState().approveExpense(expenseId, session.user.id);
    }
    try { router.push('/(app)/depenses'); } catch { /* not yet mounted */ }
    return;
  }

  // ── Expense: Refuser ────────────────────────────────────────────────────
  if (actionIdentifier === 'reject') {
    const expenseId = data.expense_id as string | undefined;
    const session   = useAuthStore.getState().session;
    if (expenseId && session) {
      await useExpensesStore.getState().rejectExpense(expenseId, session.user.id);
    }
    // No navigation — action was taken, don't interrupt
    return;
  }

  // ── Chat: inline reply ──────────────────────────────────────────────────
  if (actionIdentifier === 'reply') {
    const userText = (response as unknown as { userText?: string }).userText?.trim();
    if (!userText) return;

    const session = useAuthStore.getState().session;
    const { boutiqueRoom } = useChatStore.getState();
    const roomId = (data.room_id as string | undefined) || boutiqueRoom?.id;

    if (roomId && session) {
      void useChatStore.getState().sendMessage({
        roomId,
        senderId:   session.user.id,
        senderName: session.user.name || '',
        content:    userText,
      });
    }
    // No navigation — user stayed on their lock screen, message was sent silently
    return;
  }
}

// ─── Component ────────────────────────────────────────────────────────────────
export function NotificationSetup(): null {
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  useEffect(() => {
    const N = getNotifications();
    if (!N) return; // native module not linked into this binary yet — skip silently

    void setupAndRegister();

    // Cold start also counts as "the user has now seen their notifications" —
    // reset the server-side counter so the next background push's badge
    // starts fresh instead of continuing from wherever it left off.
    const coldStartUid = useAuthStore.getState().session?.user.id;
    if (coldStartUid) void resetUnreadBadge(coldStartUid);

    // Handle notification that launched the app (cold start from a tap).
    // Defer by 600ms so the Stack has finished rendering its initial route
    // before we push a new one — pushing before the initial route is set crashes.
    void N.getLastNotificationResponseAsync().then(response => {
      if (response) setTimeout(() => void handleResponse(response), 600);
    });

    // Foreground notification — no banner/toast shown, just keep the badge accurate
    const foregroundSub = N.addNotificationReceivedListener(() => {
      void N.getBadgeCountAsync().then(count => {
        void N.setBadgeCountAsync(count + 1);
      });
    });

    // Notification tap or action button press
    const responseSub = N.addNotificationResponseReceivedListener(response => {
      void handleResponse(response);
    });

    // App comes to foreground — clear the badge
    const appStateSub = AppState.addEventListener('change', (nextState) => {
      if (appStateRef.current !== 'active' && nextState === 'active') {
        void N.setBadgeCountAsync(0);
        const uid = useAuthStore.getState().session?.user.id;
        if (uid) void resetUnreadBadge(uid);
        void setupAndRegister(); // re-register in case token rotated
      }
      appStateRef.current = nextState;
    });

    return () => {
      foregroundSub.remove();
      responseSub.remove();
      appStateSub.remove();
    };
  }, []);

  return null;
}
