import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, InteractionManager, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '@/src/components/ui/Screen';
import { Button } from '@/src/components/ui/Button';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore, getLastPhone } from '@/stores/auth';

// Biometric-only re-entry: Face ID/Touch ID is tried silently on mount,
// showing only a calm lock icon. There is no PIN fallback anywhere — a hard
// failure (no hardware/enrollment, or a genuine lockout) goes straight to a
// full WhatsApp OTP re-login, while a soft failure (accidental cancel, an
// interrupted prompt, a single bad read) offers an immediate retry instead of
// punishing the user with a forced sign-out.
type Phase = 'checking' | 'retry' | 'restore-failed' | 'unavailable';

export default function VerrouilleScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const unlockWithBiometric = useAuthStore(s => s.unlockWithBiometric);

  const [phase, setPhase] = useState<Phase>('checking');
  const [lastPhone, setLastPhone] = useState<string | null>(null);

  const breathOpacity = useRef(new Animated.Value(0.5)).current;

  useEffect(() => {
    if (phase !== 'checking' && phase !== 'retry') return;
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(breathOpacity, { toValue: 1, duration: 900, useNativeDriver: true }),
        Animated.timing(breathOpacity, { toValue: 0.4, duration: 900, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [phase, breathOpacity]);

  useEffect(() => {
    getLastPhone().then(setLastPhone);
  }, []);

  async function attemptBiometric() {
    setPhase('checking');
    const result = await unlockWithBiometric();
    if (result === 'unlocked') {
      // unlockWithBiometric() only flips the store's internal `locked`/
      // `session` state — nothing was actually watching that flip to
      // navigate away from this screen, so a successful Face ID/Touch ID
      // read used to leave the user stranded right here. Same
      // activeBusiness branch every other post-auth screen uses
      // (connexion.tsx, (welcome)/index.tsx, recuperation.tsx, creer.tsx).
      const activeBusiness = useAuthStore.getState().session?.activeBusiness;
      router.replace(activeBusiness ? '/(app)/(tabs)/' : '/(app)/onboarding/');
      return;
    }
    if (result === 'retryable') setPhase('retry');
    else if (result === 'restore-failed') setPhase('restore-failed');
    else setPhase('unavailable');
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

  async function degradeToFullLogin() {
    await useAuthStore.getState().logout();
    router.replace({ pathname: '/(welcome)/connexion', params: lastPhone ? { prefillPhone: lastPhone } : {} });
  }

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.kav}>
        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
          <View style={styles.content}>
            {(phase === 'checking' || phase === 'retry') && (
              <View style={styles.lockOnly}>
                <Animated.View style={{ opacity: breathOpacity }}>
                  <Ionicons name="lock-closed" size={64} color={palette.textSecondary} />
                </Animated.View>
              </View>
            )}

            {phase === 'restore-failed' && (
              <View style={styles.form}>
                <Text variant="bodySmall" color="warning" style={styles.sub}>
                  Impossible de vous reconnecter. Vérifiez votre connexion et réessayez.
                </Text>
                <Button label="Réessayer" onPress={attemptBiometric} fullWidth size="lg" />
              </View>
            )}

            {phase === 'unavailable' && (
              <View style={styles.form}>
                <Text variant="bodySmall" color="secondary" style={styles.sub}>
                  Authentification biométrique indisponible sur cet appareil.
                </Text>
                <Button label="Se connecter via WhatsApp" onPress={degradeToFullLogin} fullWidth size="lg" />
              </View>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    kav:           { flex: 1, backgroundColor: p.background },
    scrollContent: { flexGrow: 1 },
    content:       { flex: 1, padding: spacing[6], paddingTop: spacing[24], gap: spacing[6], justifyContent: 'flex-start', alignItems: 'center' },
    lockOnly:      { justifyContent: 'center', alignItems: 'center' },
    sub:           { lineHeight: 22, textAlign: 'center' },
    form:          { gap: spacing[4], width: '100%' },
  });
}
