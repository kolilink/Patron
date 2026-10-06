import { useEffect } from 'react';
import { InteractionManager } from 'react-native';
import { router } from 'expo-router';
import { useAuthStore } from '@/stores/auth';
import { scheduleSessionRedirect } from '@/src/utils/navGuard';

/**
 * Welcome-stack guard: once a session exists, leave the unauthenticated screens
 * for the app (or onboarding when there is no business yet). The replace is
 * deferred until the current transition has settled (see src/utils/navGuard.ts) —
 * a replace landing mid-push froze the native transition with both screens in the
 * tree — and the session is re-read at fire time, so a session that vanished in
 * the meantime redirects nowhere.
 */
export function useSessionRedirect(): void {
  const session = useAuthStore(s => s.session);
  useEffect(() => {
    if (!session) return;
    return scheduleSessionRedirect({
      run: () => {
        const s = useAuthStore.getState().session;
        if (!s) return;
        router.replace(s.activeBusiness ? '/(app)/(tabs)/' : '/(app)/onboarding/');
      },
      runAfterInteractions: cb => InteractionManager.runAfterInteractions(cb),
      setTimeoutFn: (cb, ms) => setTimeout(cb, ms),
      clearTimeoutFn: h => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
  }, [session]);
}
