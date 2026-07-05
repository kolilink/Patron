import { useEffect, useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Screen } from '@/src/components/ui/Screen';
import { Button } from '@/src/components/ui/Button';
import { PinInput } from '@/src/components/ui/PinInput';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { hasPinSet, setPin, verifyPin } from '@/lib/pin';
import { useAuthStore } from '@/stores/auth';

// Reached three ways: (1) automatically by the routing guard for anyone
// freshly authenticated with no PIN yet — register, a real re-login,
// join-by-code — there is no skip button, a PIN is mandatory, and success
// goes straight into the app; (2) from Paramètres "Modifier le code" for an
// existing PIN, adding a "confirm the current PIN" step first; (3) from the
// Plus screen's sign-out intercept (`?afterLock=1`) for an existing user who
// chose to set up a PIN instead of fully signing out — success there must
// leave them locked (not silently still logged in), since locking was the
// thing they actually wanted when they tapped "Se déconnecter."
type Step = 'checking' | 'confirm-old' | 'enter' | 'confirm-new';

export default function CreerPinScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const [step, setStep] = useState<Step>('checking');
  const [firstPin, setFirstPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [resetSignal, setResetSignal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [isChangingExisting, setIsChangingExisting] = useState(false);
  const { afterLock } = useLocalSearchParams<{ afterLock?: string }>();

  useEffect(() => {
    hasPinSet().then(set => {
      setIsChangingExisting(set);
      setStep(set ? 'confirm-old' : 'enter');
    });
  }, []);

  async function handleOldPinComplete(pin: string) {
    setBusy(true);
    const ok = await verifyPin(pin);
    setBusy(false);
    if (!ok) {
      setError('Code incorrect. Réessayez.');
      setResetSignal(s => s + 1);
      return;
    }
    setError(null);
    setResetSignal(s => s + 1);
    setStep('enter');
  }

  function handleFirstComplete(pin: string) {
    setFirstPin(pin);
    setError(null);
    setResetSignal(s => s + 1);
    setStep('confirm-new');
  }

  async function handleConfirmComplete(pin: string) {
    if (pin !== firstPin) {
      setError('Les codes ne correspondent pas. Recommencez.');
      setResetSignal(s => s + 1);
      setFirstPin('');
      setStep('enter');
      return;
    }
    setBusy(true);
    await setPin(pin);
    if (afterLock === '1') {
      await useAuthStore.getState().lock();
      setBusy(false);
      router.replace('/(auth)/verrouille');
      return;
    }
    setBusy(false);
    // Reached from Paramètres to change an existing PIN — return to where the
    // user was rather than bouncing them to the home tab. The mandatory,
    // no-PIN-yet path (routing-guard redirect, no back stack to return to)
    // always goes to the app directly.
    if (isChangingExisting) {
      router.back();
      return;
    }
    router.replace('/(app)/(tabs)/');
  }

  const TITLES: Record<Step, string> = {
    checking:    '',
    'confirm-old': 'Confirmez votre code actuel',
    enter:       'Créez un code à 4 chiffres',
    'confirm-new': 'Confirmez votre code',
  };

  const SUBS: Record<Step, string> = {
    checking: '',
    'confirm-old': 'Entrez votre code actuel pour continuer',
    enter: "Ce code vous permettra de revenir dans l'app sans recevoir un nouveau code WhatsApp à chaque fois",
    'confirm-new': 'Entrez à nouveau le même code',
  };

  if (step === 'checking') {
    return <Screen><View style={styles.content} /></Screen>;
  }

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.kav}>
        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
          <View style={styles.content}>
            <View style={styles.header}>
              <Text variant="h2">{TITLES[step]}</Text>
              <Text variant="body" color="secondary" style={styles.sub}>{SUBS[step]}</Text>
            </View>

            {error && <Text variant="bodySmall" color="warning" style={styles.error}>{error}</Text>}

            <View style={styles.pinWrap}>
              {step === 'confirm-old' && (
                <PinInput onComplete={handleOldPinComplete} disabled={busy} autoFocus resetSignal={resetSignal} />
              )}
              {step === 'enter' && (
                <PinInput onComplete={handleFirstComplete} disabled={busy} autoFocus resetSignal={resetSignal} />
              )}
              {step === 'confirm-new' && (
                <PinInput onComplete={handleConfirmComplete} disabled={busy} autoFocus resetSignal={resetSignal} />
              )}
            </View>
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
    content:       { flex: 1, padding: spacing[6], gap: spacing[8], justifyContent: 'center' },
    header:        { gap: spacing[3] },
    sub:           { lineHeight: 22 },
    pinWrap:       { alignItems: 'center' },
    error:         { textAlign: 'center' },
  });
}
