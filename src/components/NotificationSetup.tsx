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

async function setupAndRegister(): Promise<void> {
  const session = useAuthStore.getState().session;
  if (!session || session.isDemoMode) return;

  const N = getNotifications();
  if (!N) return;

  // Every call below is backed by a native module that only exists in a real
  // dev-client/production build (missing under Expo Go, or an older binary
  // built before this dependency was linked) — one try/catch around the whole
  // flow so any of them failing never surfaces as an unhandled rejection.
  try {
    const perms = await N.requestPermissionsAsync();
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

// ─── Notification action handler ─────────────────────────────────────────────
async function handleResponse(response: Notifications.NotificationResponse): Promise<void> {
  const N = getNotifications();
  if (!N) return;

  const { actionIdentifier, notification } = response;
  const data = notification.request.content.data as Record<string, unknown>;

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
