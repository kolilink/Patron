import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, PanResponder, Pressable, StyleSheet, View } from 'react-native';
import { BlurView } from 'expo-blur';
import * as LocalAuthentication from 'expo-local-authentication';
import { Button } from '@/src/components/ui/Button';
import { Text } from '@/src/components/ui/Text';
import { palette, spacing } from '@/src/theme';

type LockState = 'clear' | 'blurred' | 'auth';

const INACTIVITY_MS  = 60_000;        // 1 min no touch → blur
const BACKGROUND_MS  = 3 * 60_000;   // 3 min backgrounded → auth

export function AppLockOverlay({ children }: { children: React.ReactNode }) {
  // Use a ref so AppState callbacks always read the current value (no stale closure)
  const lockRef  = useRef<LockState>('clear');
  const [lockState, _setLock] = useState<LockState>('clear');

  const setLock = useCallback((next: LockState) => {
    lockRef.current = next;
    _setLock(next);
  }, []);

  const inactivityTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backgroundAt    = useRef<number | null>(null);

  // ─── Inactivity timer ────────────────────────────────────────────────────────

  const resetInactivityTimer = useCallback(() => {
    if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
    inactivityTimer.current = setTimeout(() => {
      // Only blur from clear — never downgrade auth state
      if (lockRef.current === 'clear') setLock('blurred');
    }, INACTIVITY_MS);
  }, [setLock]);

  useEffect(() => {
    resetInactivityTimer();
    return () => {
      if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
    };
  }, [resetInactivityTimer]);

  // ─── Biometric authentication ─────────────────────────────────────────────────

  const triggerBiometric = useCallback(async () => {
    try {
      const [hasHardware, isEnrolled] = await Promise.all([
        LocalAuthentication.hasHardwareAsync(),
        LocalAuthentication.isEnrolledAsync(),
      ]);

      if (!hasHardware || !isEnrolled) {
        // Device has no security configured — let them through silently
        setLock('clear');
        resetInactivityTimer();
        return;
      }

      const result = await LocalAuthentication.authenticateAsync({
        promptMessage:        'Confirmez votre identité pour continuer',
        fallbackLabel:        'Utiliser le code',
        disableDeviceFallback: false,
        cancelLabel:          'Annuler',
      });

      if (result.success) {
        setLock('clear');
        resetInactivityTimer();
      }
      // On failure or cancel: stay in auth — overlay stays visible with retry button
    } catch {
      // Unexpected error (crashed API, permissions, etc.) — stay locked.
      // User taps "Déverrouiller" to retry. Never fail open on exceptions.
    }
  }, [setLock, resetInactivityTimer]);

  // Auto-trigger biometric as soon as auth state is entered
  useEffect(() => {
    if (lockState === 'auth') triggerBiometric();
  }, [lockState, triggerBiometric]);

  // ─── AppState: background / foreground tracking ────────────────────────────────

  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'background' || nextState === 'inactive') {
        backgroundAt.current = Date.now();
        // Pause inactivity timer while backgrounded
        if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
      } else if (nextState === 'active') {
        const bgStart = backgroundAt.current;
        backgroundAt.current = null;

        // Already locked — re-trigger biometric (user may have dismissed it)
        if (lockRef.current === 'auth') {
          triggerBiometric();
          return;
        }

        if (bgStart !== null && Date.now() - bgStart >= BACKGROUND_MS) {
          setLock('auth');
          // Don't restart inactivity timer — wait for auth success
        } else {
          resetInactivityTimer();
        }
      }
    });
    return () => sub.remove();
  }, [triggerBiometric, resetInactivityTimer, setLock]);

  // ─── Touch handler (inactivity reset) ───────────────────────────────────────
  // PanResponder with capture=false observes every touch even when a child
  // ScrollView / Pressable captures it — onTouchStart on a plain View would miss
  // those and let the timer expire while the user is actively interacting.

  const resetRef = useRef(resetInactivityTimer);
  useEffect(() => { resetRef.current = resetInactivityTimer; }, [resetInactivityTimer]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponderCapture: () => {
        if (lockRef.current !== 'auth') resetRef.current();
        return false; // never steal the touch — just observe it
      },
      onMoveShouldSetPanResponderCapture: () => {
        if (lockRef.current !== 'auth') resetRef.current();
        return false;
      },
    })
  ).current;

  // ─── Render ───────────────────────────────────────────────────────────────────

  return (
    <View style={styles.root} {...panResponder.panHandlers}>
      {children}

      {lockState !== 'clear' && (
        <BlurView
          intensity={lockState === 'auth' ? 92 : 72}
          tint="dark"
          style={StyleSheet.absoluteFill}
        >
          {lockState === 'blurred' ? (
            // Inactivity blur: full-screen tap target clears it
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={() => { setLock('clear'); resetInactivityTimer(); }}
            />
          ) : (
            // Auth required: show locked UI, no way to tap past it
            <View style={styles.authContainer} pointerEvents="box-none">
              <View style={styles.authCard}>
                <Text variant="h4" style={styles.authTitle}>
                  Session verrouillée
                </Text>
                <Text variant="body" color="secondary" style={styles.authSub}>
                  Veuillez confirmer votre identité pour continuer.
                </Text>
                <Button
                  label="Déverrouiller"
                  onPress={triggerBiometric}
                  fullWidth
                  size="lg"
                  style={{ marginTop: spacing[2] }}
                />
              </View>
            </View>
          )}
        </BlurView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  authContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing[6],
  },
  authCard: {
    width: '100%',
    backgroundColor: palette.surface,
    borderRadius: 16,
    padding: spacing[6],
    gap: spacing[3],
    alignItems: 'center',
  },
  authTitle: {
    textAlign: 'center',
  },
  authSub: {
    textAlign: 'center',
  },
});
