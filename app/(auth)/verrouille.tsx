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
    // 'unlocked' → nothing to do, the route guards redirect automatically
    // once `locked` flips false.
    if (result === 'unlocked') return;
    if (result === 'retryable') setPhase('retry');
    else if (result === 'restore-failed') setPhase('restore-failed');
    else setPhase('unavailable');
  }

  useEffect(() => {
    // Firing authenticateAsync while this screen's own mount/route transition
    // is still animating makes the OS silently reject the prompt with no
    // native UI at all — waiting for interactions to finish avoids racing it.
    const task = InteractionManager.runAfterInteractions(() => {
      attemptBiometric();
    });
    return () => task.cancel();
  }, []);

  async function degradeToFullLogin() {
    await useAuthStore.getState().logout();
    router.replace({ pathname: '/(welcome)/connexion', params: lastPhone ? { prefillPhone: lastPhone } : {} });
  }

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.kav}>
        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
          <View style={styles.content}>
            <View style={styles.header}>
              <Animated.View style={{ opacity: (phase === 'checking' || phase === 'retry') ? breathOpacity : 1 }}>
                <Ionicons name="lock-closed" size={40} color={palette.textSecondary} />
              </Animated.View>
            </View>

            {(phase === 'checking' || phase === 'retry') && (
              <>
                {phase === 'retry' && (
                  <Button label="Réessayer" onPress={attemptBiometric} fullWidth size="lg" />
                )}
                <Button label="Se connecter via WhatsApp" variant="ghost" onPress={degradeToFullLogin} />
              </>
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

function makeStyles(_p: Palette) {
  return StyleSheet.create({
    kav:           { flex: 1 },
    scrollContent: { flexGrow: 1 },
    // flex-start + paddingTop (not centered) — keeps the lock icon and the
    // Réessayer/WhatsApp buttons within easy one-handed thumb reach near the
    // top-middle of the screen, instead of sitting dead-center where a thumb
    // has to stretch down the phone to tap them.
    content:       { flex: 1, padding: spacing[6], paddingTop: spacing[20], gap: spacing[6], justifyContent: 'flex-start', alignItems: 'center' },
    header:        { gap: spacing[3], alignItems: 'center' },
    sub:           { lineHeight: 22, textAlign: 'center' },
    form:          { gap: spacing[4], width: '100%' },
  });
}
