import { useEffect, useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@/src/components/ui/Screen';
import { Button } from '@/src/components/ui/Button';
import { PinInput } from '@/src/components/ui/PinInput';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore, getLastPhone } from '@/stores/auth';
import { getPinFailCount, MAX_PIN_ATTEMPTS } from '@/lib/pin';

export default function VerrouilleScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const unlockWithPin = useAuthStore(s => s.unlockWithPin);
  const unlockWithBiometric = useAuthStore(s => s.unlockWithBiometric);

  const [lastPhone, setLastPhone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attemptsLeft, setAttemptsLeft] = useState(MAX_PIN_ATTEMPTS);
  const [locked, setLockedOut] = useState(false);
  const [resetSignal, setResetSignal] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getLastPhone().then(setLastPhone);
    getPinFailCount().then(count => setAttemptsLeft(Math.max(0, MAX_PIN_ATTEMPTS - count)));
    void unlockWithBiometric();
  }, []);

  async function handlePinComplete(pin: string) {
    setBusy(true);
    const result = await unlockWithPin(pin);
    setBusy(false);

    if (result === 'unlocked') return; // routing guard redirects automatically once `locked` flips false

    if (result === 'restore-failed') {
      // The PIN was correct — this is a connectivity/session issue, not a bad
      // code. Never count it against the attempt limit or blame the PIN.
      setResetSignal(s => s + 1);
      setError('Impossible de vous reconnecter. Vérifiez votre connexion et réessayez.');
      return;
    }

    const failCount = await getPinFailCount();
    const remaining = Math.max(0, MAX_PIN_ATTEMPTS - failCount);
    setAttemptsLeft(remaining);
    setResetSignal(s => s + 1);
    if (remaining <= 0) {
      setLockedOut(true);
    } else {
      setError(`Code incorrect. ${remaining} tentative${remaining > 1 ? 's' : ''} restante${remaining > 1 ? 's' : ''}.`);
    }
  }

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
              <Text variant="h2">Bonjour {lastPhone ? `· ${lastPhone}` : ''}</Text>
              <Text variant="body" color="secondary" style={styles.sub}>
                {attemptsLeft < MAX_PIN_ATTEMPTS
                  ? `Entrez votre code pour continuer (${attemptsLeft} tentative${attemptsLeft > 1 ? 's' : ''} restante${attemptsLeft > 1 ? 's' : ''})`
                  : 'Entrez votre code pour continuer'}
              </Text>
            </View>

            {error && <Text variant="bodySmall" color="warning" style={styles.error}>{error}</Text>}

            {!locked ? (
              <>
                <View style={styles.pinWrap}>
                  <PinInput onComplete={handlePinComplete} disabled={busy} autoFocus resetSignal={resetSignal} />
                </View>
                <Button label="Changer de compte" variant="ghost" onPress={degradeToFullLogin} />
              </>
            ) : (
              <View style={styles.form}>
                <Text variant="bodySmall" color="secondary" style={styles.sub}>
                  Trop de tentatives. Reconnectez-vous avec un nouveau code envoyé par WhatsApp.
                </Text>
                <Button label="Se reconnecter avec un nouveau code" onPress={degradeToFullLogin} fullWidth size="lg" />
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
    content:       { flex: 1, padding: spacing[6], gap: spacing[6], justifyContent: 'center', alignItems: 'center' },
    header:        { gap: spacing[3], alignItems: 'center' },
    sub:           { lineHeight: 22, textAlign: 'center' },
    pinWrap:       { alignItems: 'center' },
    form:          { gap: spacing[4], width: '100%' },
    error:         { textAlign: 'center' },
  });
}
