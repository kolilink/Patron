import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, InteractionManager, Platform, Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@/src/components/ui/Screen';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing, fontFamily } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore, getLastPhone, getLastBusinessName } from '@/stores/auth';

// Biometric-only re-entry: Face ID/Touch ID fires automatically on mount, no
// tap required. A soft failure (accidental cancel, an interrupted prompt, a
// bad read, or a restore-after-success network hiccup) shows one calm inline
// line and lets the same tap-anywhere gesture retry; there is no PIN in this
// app, so "Utiliser le code" is the WhatsApp OTP re-login already used
// elsewhere (stores/auth.ts has never had a device-passcode fallback here —
// see unlockWithBiometric's disableDeviceFallback — this button is the real,
// always-available escape hatch that fills the same role). A hard failure
// (no hardware, not enrolled) skips this screen's UI entirely and goes
// straight there too, per the same function.
type Phase = 'prompting' | 'failed';

export default function VerrouilleScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const unlockWithBiometric = useAuthStore(s => s.unlockWithBiometric);

  const [phase, setPhase] = useState<Phase>('prompting');
  const [lastPhone, setLastPhone] = useState<string | null>(null);
  const [businessName, setBusinessName] = useState<string | null>(null);
  // Session is cleared while locked (see stores/auth.ts's lock()), so the
  // business name shown here can't come from the live session — it's read
  // from the same small SecureStore cache getLastPhone already established
  // for exactly this "screen has no session yet" situation.
  const fadeOpacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    getLastPhone().then(setLastPhone);
    getLastBusinessName().then(setBusinessName);
  }, []);

  async function degradeToCode() {
    await useAuthStore.getState().logout();
    router.replace({ pathname: '/(welcome)/connexion', params: lastPhone ? { prefillPhone: lastPhone } : {} });
  }

  async function attemptBiometric() {
    setPhase('prompting');
    const result = await unlockWithBiometric();
    if (result === 'unlocked') {
      // Fast fade, no intermediate success/checkmark screen — the OS already
      // shows its own system check during the Face ID/Touch ID sheet itself.
      Animated.timing(fadeOpacity, { toValue: 0, duration: 160, useNativeDriver: true }).start(() => {
        const activeBusiness = useAuthStore.getState().session?.activeBusiness;
        router.replace(activeBusiness ? '/(app)/(tabs)/' : '/(app)/onboarding/');
      });
      return;
    }
    // 'unavailable' (no hardware/enrollment, or a hard failure) and
    // 'restore-failed' (biometric succeeded, session restore didn't) both
    // collapse into the same visible outcome here: no dead-end screen, just
    // the one real fallback this app has. Distinguishing them was only ever
    // useful for the old "Se connecter via WhatsApp" vs "Réessayer" split —
    // this screen no longer needs that split now that retry is a plain tap
    // anywhere and the code fallback is always on screen regardless.
    if (result === 'unavailable') { degradeToCode(); return; }
    setPhase('failed'); // 'retryable' or 'restore-failed'
  }

  useEffect(() => {
    // Firing authenticateAsync while this screen's own mount/route transition
    // is still animating makes the OS silently reject the prompt with no
    // native UI at all — waiting for interactions to finish avoids racing it.
    // But a stuck/never-resolving interaction handle (seen intermittently on
    // both platforms) would then delay the prompt indefinitely with no
    // visible sign anything is wrong — race it against a flat timeout so the
    // attempt always fires within ~600ms either way.
    //
    // Android needs a longer ceiling than iOS: on the background-return path
    // (app/(app)/_layout.tsx's AppState listener calling lock() the instant
    // AppState reports 'active'), Android's own window-focus restoration
    // after returning from background runs on a native timeline separate
    // from this InteractionManager check — on a low-end/low-memory device
    // it can still be settling once the 600ms fallback used to fire,
    // and BiometricPrompt auto-cancels (surfaces as error: 'user_cancel',
    // indistinguishable from a real dismissal) if invoked before the window
    // actually has focus. Confirmed via a production Sentry event
    // (Samsung Galaxy A14 5G, Android 15, "device.class: low", 985MB free)
    // where the user reported the fingerprint itself succeeded yet still
    // landed back on this retry screen. This is a probabilistic OS race,
    // not something a fixed delay eliminates outright — just widens the
    // margin. iOS hasn't shown this failure mode, so it keeps the tighter
    // bound instead of slowing every unlock down for everyone.
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
        {/* Tapping anywhere in the failed state retries — "réessayez" needs
            a real, generous gesture behind it, not a hidden button. Inert
            while genuinely prompting, so it can't double-fire a native
            sheet that may already be up (unlockWithBiometric's own
            in-flight guard would just no-op it anyway, but disabling here
            avoids a confusing extra tap doing nothing visible). */}
        <Pressable
          style={styles.centerBlock}
          onPress={phase === 'failed' ? attemptBiometric : undefined}
        >
          <View style={styles.mark}>
            <Text style={styles.markLetter}>P</Text>
          </View>
          {businessName ? <Text style={styles.businessName}>{businessName}</Text> : null}
          <Text variant="h1" style={styles.centerText}>Bon retour</Text>
          <Text variant="body" color="secondary" style={styles.centerText}>
            Regardez votre téléphone pour continuer.
          </Text>
          {phase === 'failed' && (
            <Text variant="bodySmall" color="secondary" style={[styles.centerText, styles.inlineNotice]}>
              Non reconnu — réessayez ou utilisez le code.
            </Text>
          )}
        </Pressable>

        <Pressable onPress={degradeToCode} style={styles.codeButton} hitSlop={12}>
          <Text variant="labelLarge" color="secondary">Utiliser le code</Text>
        </Pressable>
      </Animated.View>
    </Screen>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    content: {
      flex: 1, alignItems: 'center', paddingHorizontal: spacing[6],
      paddingTop: spacing[20], paddingBottom: spacing[8],
    },
    centerBlock: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing[2] },
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
    // enlarged fontSize with no matching lineHeight clips the glyph's top,
    // which is exactly the bug that shipped here the first time.
    markLetter: { fontFamily: fontFamily.bold, fontSize: 32, lineHeight: 40, color: p.textInverse },
    businessName: { fontFamily: fontFamily.semibold, fontSize: 17, lineHeight: 28, color: p.textPrimary, marginBottom: spacing[1] },
    centerText: { textAlign: 'center' },
    inlineNotice: { marginTop: spacing[4] },
    codeButton: { minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing[6] },
  });
}
