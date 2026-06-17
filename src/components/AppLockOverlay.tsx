import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, AppState, Pressable, StyleSheet, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as LocalAuthentication from 'expo-local-authentication';
import { Text } from '@/src/components/ui/Text';
import { useTheme } from '@/src/theme';
import { spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';

type LockState = 'clear' | 'auth';

const BACKGROUND_MS = 3 * 60_000;

export function AppLockOverlay({ children }: { children: React.ReactNode }) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(palette, insets.top), [palette, insets.top]);

  const lockRef = useRef<LockState>('clear');
  const [lockState, _setLock] = useState<LockState>('clear');
  const [biometricFailed, setBiometricFailed] = useState(false);

  const breathOpacity = useRef(new Animated.Value(0.5)).current;
  const breathAnim = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    if (lockState === 'auth') {
      breathAnim.current = Animated.loop(
        Animated.sequence([
          Animated.timing(breathOpacity, { toValue: 1,   duration: 900, useNativeDriver: true }),
          Animated.timing(breathOpacity, { toValue: 0.4, duration: 900, useNativeDriver: true }),
        ])
      );
      breathAnim.current.start();
    } else {
      breathAnim.current?.stop();
      breathOpacity.setValue(0.5);
    }
  }, [lockState, breathOpacity]);

  const setLock = useCallback((next: LockState) => {
    lockRef.current = next;
    _setLock(next);
    if (next !== 'auth') setBiometricFailed(false);
  }, []);

  const backgroundAt = useRef<number | null>(null);

  const triggerBiometric = useCallback(async () => {
    setBiometricFailed(false);
    try {
      const [hasHardware, isEnrolled] = await Promise.all([
        LocalAuthentication.hasHardwareAsync(),
        LocalAuthentication.isEnrolledAsync(),
      ]);

      if (!hasHardware || !isEnrolled) {
        setLock('clear');
        return;
      }

      const result = await LocalAuthentication.authenticateAsync({
        promptMessage:         'Confirmez votre identité pour continuer',
        fallbackLabel:         'Utiliser le code',
        disableDeviceFallback: false,
        cancelLabel:           'Annuler',
      });

      if (result.success) {
        setLock('clear');
      } else {
        setBiometricFailed(true);
      }
    } catch {
      setBiometricFailed(true);
    }
  }, [setLock]);

  useEffect(() => {
    if (lockState === 'auth') triggerBiometric();
  }, [lockState, triggerBiometric]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'background' || nextState === 'inactive') {
        backgroundAt.current = Date.now();
      } else if (nextState === 'active') {
        const bgStart = backgroundAt.current;
        backgroundAt.current = null;

        if (lockRef.current === 'auth') {
          triggerBiometric();
          return;
        }

        if (bgStart !== null && Date.now() - bgStart >= BACKGROUND_MS) {
          setLock('auth');
        }
      }
    });
    return () => sub.remove();
  }, [triggerBiometric, setLock]);

  return (
    <View style={styles.root}>
      {children}

      {lockState === 'auth' && (
        <BlurView
          intensity={92}
          tint="dark"
          style={StyleSheet.absoluteFill}
        >
          <View style={styles.authContainer} pointerEvents="box-none">
            <View style={styles.topSection}>
              <Text style={styles.wordmark}>Patron</Text>
            </View>

            <View style={styles.centerSection}>
              <Animated.View style={{ opacity: breathOpacity }}>
                <Ionicons name="lock-closed" size={34} color="rgba(255,255,255,0.80)" />
              </Animated.View>
            </View>

            {biometricFailed && (
              <View style={styles.bottomSection}>
                <Pressable onPress={triggerBiometric} style={styles.retryWrap}>
                  <Text style={styles.retryText}>Réessayer</Text>
                </Pressable>
              </View>
            )}
          </View>
        </BlurView>
      )}
    </View>
  );
}

function makeStyles(_p: Palette, topInset: number) {
  return StyleSheet.create({
    root: { flex: 1 },
    authContainer: {
      flex: 1,
      paddingTop: topInset,
    },
    topSection: {
      paddingTop: spacing[14],
      alignItems: 'center',
    },
    centerSection: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
    },
    bottomSection: {
      paddingBottom: spacing[12],
      alignItems: 'center',
    },
    wordmark: {
      fontSize: 26,
      fontWeight: '300',
      letterSpacing: 3,
      color: 'rgba(255,255,255,0.85)',
    },
    retryWrap: {
      paddingVertical: spacing[2],
      paddingHorizontal: spacing[4],
    },
    retryText: {
      fontSize: 14,
      color: 'rgba(255,255,255,0.45)',
      letterSpacing: 0.5,
    },
  });
}
