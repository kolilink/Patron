import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, InteractionManager, Platform, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@/src/components/ui/Screen';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing, fontFamily } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore, getLastBusinessName } from '@/stores/auth';

// OS-native re-entry only: Face ID/Touch ID (or the OS's own device-credential
// fallback, since unlockWithBiometric uses disableDeviceFallback: false) fires
// automatically on mount. The OS renders its own retry/fallback UI ("Try
// Again" / "Enter Passcode" / the Android system prompt), so the app shows no
// error copy and no "use a code instead" escape hatch — there is no app-level
// code fallback anymore. If the device has neither a biometric nor a device
// credential enrolled, unlockWithBiometric restores the local session cache
// and the routing guard passes straight through, so a dead lock screen is
// never shown. The full-screen opaque Screen below is also the recent-apps
// privacy shield, even when auth itself is skipped.
export default function VerrouilleScreen() {
  const { palette } = useTheme();
  const { height } = useWindowDimensions();
  const styles = useMemo(() => makeStyles(palette, height), [palette, height]);
  const unlockWithBiometric = useAuthStore(s => s.unlockWithBiometric);

  const [businessName, setBusinessName] = useState<string | null>(null);
  // Session is cleared while locked (see stores/auth.ts's lock()), so the
  // business name shown here can't come from the live session — it's read
  // from the small SecureStore cache established for exactly this "screen has
  // no session yet" situation.
  const fadeOpacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    getLastBusinessName().then(setBusinessName);
  }, []);

  async function attemptBiometric() {
    const result = await unlockWithBiometric();
    if (result === 'unlocked') {
      // Fast fade, no intermediate success/checkmark screen — the OS already
      // shows its own system check during the Face ID/Touch ID sheet itself.
      Animated.timing(fadeOpacity, { toValue: 0, duration: 160, useNativeDriver: true }).start(() => {
        const activeBusiness = useAuthStore.getState().session?.activeBusiness;
        router.replace(activeBusiness ? '/(app)/(tabs)/' : '/(app)/onboarding/');
      });
    }
    // 'retryable' (a cancel/interruption) leaves the screen as-is — the OS owns
    // the retry surface, so the app shows no duplicated error copy and simply
    // waits for the next tap.
  }

  useEffect(() => {
    // Firing authenticateAsync while this screen's own mount/route transition
    // is still animating makes the OS silently reject the prompt with no
    // native UI at all — waiting for interactions to finish avoids racing it.
    // A stuck/never-resolving interaction handle would then delay the prompt
    // indefinitely, so it's raced against a flat timeout: the attempt always
    // fires within ~600ms either way.
    //
    // Android needs a longer ceiling than iOS: on the background-return path
    // (app/(app)/_layout.tsx's AppState listener calling lock() the instant
    // AppState reports 'active'), Android's own window-focus restoration runs
    // on a native timeline separate from this InteractionManager check, and
    // BiometricPrompt auto-cancels (error: 'user_cancel') if invoked before
    // the window actually has focus. iOS hasn't shown this failure mode, so it
    // keeps the tighter bound.
    let fired = false;
    const fire = () => {
      if (fired) return;
      fired = true;
      attemptBiometric();
    };
    const task = InteractionManager.runAfterInteractions(fire);
    const timeout = setTimeout(fire, Platform.OS === 'android' ? 1200 : 600);
    return () => {
      task.cancel();
      clearTimeout(timeout);
    };
  }, []);

  return (
    <Screen>
      <Animated.View style={[styles.content, { opacity: fadeOpacity }]}>
        {/* Tapping anywhere re-invokes the OS prompt (a cancel/interruption
            leaves the user here with no duplicated error text). unlockWithBiometric's
            own in-flight guard drops a stacked call while a native sheet is
            already up, so this can't double-fire a prompt. */}
        <Pressable style={styles.centerBlock} onPress={attemptBiometric}>
          <View style={styles.mark}>
            <Text style={styles.markLetter}>P</Text>
          </View>
          {businessName ? <Text style={styles.businessName}>{businessName}</Text> : null}
          <Text variant="h1" style={styles.centerText}>Bon retour</Text>
          <Text variant="body" color="secondary" style={styles.centerText}>
            Déverrouillez Patron pour continuer.
          </Text>
        </Pressable>
      </Animated.View>
    </Screen>
  );
}

function makeStyles(p: Palette, viewportHeight: number) {
  return StyleSheet.create({
    content: { flex: 1 },
    // The content block (mark → "Bon retour" → instruction) is centered in the
    // remaining space above an ~8% viewport-height bottom reserve, which lifts
    // its optical center to ~42-44% of viewport height — visually centered,
    // not top-aligned.
    centerBlock: {
      flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing[2],
      paddingHorizontal: spacing[6],
      paddingBottom: Math.round(viewportHeight * 0.08),
    },
    // Brand purple lives here only — nowhere else on this screen.
    mark: {
      width: 72, height: 72, borderRadius: 20,
      backgroundColor: p.primary, alignItems: 'center', justifyContent: 'center',
      marginBottom: spacing[4],
    },
    // No exact <Text variant> matches these two, so fontFamily + lineHeight
    // are set explicitly and together — never fontSize/fontWeight alone.
    // This app's fonts are separate files per weight (see FF in
    // src/theme/typography.ts), so a bare `fontWeight` does nothing; and an
    // enlarged fontSize with no matching lineHeight clips the glyph's top.
    markLetter: { fontFamily: fontFamily.bold, fontSize: 32, lineHeight: 40, color: p.textInverse },
    businessName: { fontFamily: fontFamily.semibold, fontSize: 17, lineHeight: 28, color: p.textPrimary, marginBottom: spacing[1] },
    centerText: { textAlign: 'center' },
  });
}
