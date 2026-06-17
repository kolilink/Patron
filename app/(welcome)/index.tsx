import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as LocalAuthentication from 'expo-local-authentication';
import { Button } from '@/src/components/ui/Button';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore, getLastPhone } from '@/stores/auth';

export default function WelcomeScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const session = useAuthStore(s => s.session);
  const loading = useAuthStore(s => s.loading);
  const loginWithBiometric = useAuthStore(s => s.loginWithBiometric);
  const loginWithPhone = useAuthStore(s => s.loginWithPhone);

  const [showBiometric, setShowBiometric] = useState(false);

  useEffect(() => {
    async function checkBiometric() {
      const [hasHardware, isEnrolled, phone] = await Promise.all([
        LocalAuthentication.hasHardwareAsync(),
        LocalAuthentication.isEnrolledAsync(),
        getLastPhone(),
      ]);
      setShowBiometric(hasHardware && isEnrolled && !!phone);
    }
    checkBiometric();
  }, []);

  useEffect(() => {
    if (!session) return;
    if (session.activeBusiness) {
      router.replace('/(app)/(tabs)/');
    } else {
      router.replace('/(app)/onboarding/');
    }
  }, [session]);

  const handleBiometricLogin = async () => {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage:         'Connexion à Patron',
      fallbackLabel:         'Utiliser le code',
      disableDeviceFallback: false,
      cancelLabel:           'Annuler',
    });
    if (!result.success) return;

    // Try silent session restore (works when session is still alive on server).
    const ok = await loginWithBiometric();
    if (ok) return; // useEffect navigates once session is set

    // Session gone (explicit logout or token expiry) → auto-send OTP to the
    // stored phone number so the user skips phone entry and lands on the code screen.
    const phone = await getLastPhone();
    if (phone) {
      const loginResult = await loginWithPhone(phone);
      if (loginResult) {
        router.push({ pathname: '/(welcome)/connexion', params: { autoOtp: '1' } });
        return;
      }
    }
    router.push('/(welcome)/connexion');
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.content}>
        <View style={styles.hero}>
          <Text variant="display" color="brand" style={styles.logo}>patron</Text>
          <Text variant="h3" style={styles.tagline}>
            Soyez le patron
          </Text>
        </View>

        <View style={styles.actions}>
          <Button
            label="Créer mon commerce"
            onPress={() => router.push('/(welcome)/creer')}
            fullWidth
            size="lg"
          />
          <Button
            label="Rejoindre un commerce"
            variant="secondary"
            onPress={() => router.push('/(welcome)/rejoindre')}
            fullWidth
            size="lg"
          />
          {showBiometric && (
            <Button
              label="Connexion rapide"
              variant="secondary"
              onPress={handleBiometricLogin}
              loading={loading}
              fullWidth
              size="lg"
            />
          )}
          {!session && (
            <Button
              label="J'ai déjà un compte"
              variant="ghost"
              onPress={() => router.push('/(welcome)/connexion')}
              fullWidth
            />
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: p.background },
    content: {
      flex: 1,
      paddingHorizontal: spacing[8],
      paddingVertical: spacing[10],
      justifyContent: 'center',
      gap: spacing[16],
    },
    hero: {
      alignItems: 'center',
      gap: spacing[5],
    },
    logo: { letterSpacing: -1 },
    tagline: { textAlign: 'center', lineHeight: 30, color: p.textSecondary },
    actions: { gap: spacing[3] },
  });
}
