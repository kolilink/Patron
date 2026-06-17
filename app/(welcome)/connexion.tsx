import { useEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Linking,
  Platform,
  StyleSheet,
  View,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from '@/src/components/ui/Button';
import { OtpInput } from '@/src/components/ui/OtpInput';
import { Text } from '@/src/components/ui/Text';
import { PhoneInput } from '@/src/components/ui/PhoneInput';
import { useTheme, radius, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { trackEvent } from '@/lib/analytics';

export default function ConnexionScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const { loginWithPhone, verifyPhoneCode, restorePhoneSession, session, loading, error, clearError } = useAuthStore();
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [phone, setPhone] = useState('');
  const [phoneComplete, setPhoneComplete] = useState(false);
  const [resetKey, setResetKey]   = useState(0);
  const [otpKey, setOtpKey]       = useState(0);
  const verificationIdRef         = useRef('');
  const normalizedPhoneRef        = useRef('');

  const { autoOtp } = useLocalSearchParams<{ autoOtp?: string }>();

  useEffect(() => {
    clearError();
    trackEvent('auth_login_screen_viewed', null, null);
  }, []);

  // When arriving from the biometric quick-login fallback, the OTP has already
  // been sent and pendingPhoneVerification is set — jump straight to code entry.
  useEffect(() => {
    if (autoOtp !== '1') return;
    const pv = useAuthStore.getState().pendingPhoneVerification;
    if (!pv) return;
    normalizedPhoneRef.current = pv.phone;
    verificationIdRef.current  = pv.verificationId;
    setStep('otp');
  }, [autoOtp]);

  useEffect(() => {
    if (!session) return;
    if (session.activeBusiness) {
      router.replace('/(app)/(tabs)/');
    } else {
      router.replace('/(app)/onboarding/');
    }
  }, [session]);

  const handleContinuer = async () => {
    clearError();
    const normalized = phone.trim().replace(/\s/g, '');
    if (!normalized) return;
    normalizedPhoneRef.current = normalized;
    trackEvent('auth_phone_submitted', null, null);
    const result = await loginWithPhone(normalized);
    if (result) {
      verificationIdRef.current = result.verificationId;
      trackEvent('auth_otp_screen_shown', null, null);
      setStep('otp');
    }
  };

  const handleOtpComplete = async (code: string) => {
    const ok = await verifyPhoneCode(
      normalizedPhoneRef.current,
      code,
      verificationIdRef.current,
    );
    if (ok) {
      trackEvent('auth_otp_verified', null, null);
      await restorePhoneSession(normalizedPhoneRef.current, verificationIdRef.current);
    } else {
      trackEvent('auth_failed', null, null, { reason: 'invalid_otp' });
      setOtpKey(k => k + 1);
    }
  };

  const handleResend = async () => {
    clearError();
    setOtpKey(k => k + 1);
    const result = await loginWithPhone(normalizedPhoneRef.current);
    if (result) verificationIdRef.current = result.verificationId;
  };

  const handleRetour = () => {
    if (step === 'otp') {
      clearError();
      setStep('phone');
      setResetKey(k => k + 1);
      verificationIdRef.current = '';
      normalizedPhoneRef.current = '';
      return;
    }
    router.back();
  };

  const errorMessage = (() => {
    if (error === 'PHONE_NOT_FOUND') return "Aucun compte trouvé pour ce numéro. Créez-en un depuis l'accueil.";
    return error;
  })();

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.kav}
      >
        <View style={styles.content}>
          <View style={styles.header}>
            <Button
              label="← Retour"
              variant="ghost"
              onPress={handleRetour}
              style={styles.back}
            />
            <Text variant="h2">
              {step === 'phone' ? 'Connexion' : 'Entrez votre code'}
            </Text>
            <Text variant="body" color="secondary" style={styles.sub}>
              {step === 'phone'
                ? 'Entrez votre numéro pour accéder à votre compte.'
                : 'Votre code Patron a été envoyé par SMS. Il est valable 30 min.'}
            </Text>
          </View>

          {errorMessage ? (
            <View style={styles.errorBox}>
              <Text variant="bodySmall" style={styles.errorText}>{errorMessage}</Text>
            </View>
          ) : null}

          {step === 'phone' ? (
            <View style={styles.form}>
              <PhoneInput
                label="Votre numéro"
                onChange={(e164, complete) => { setPhone(e164); setPhoneComplete(complete); }}
                autoFocus
                resetKey={resetKey}
              />
              <Button
                label="Continuer"
                loading={loading}
                onPress={handleContinuer}
                fullWidth
                size="lg"
                disabled={!phoneComplete}
              />
            </View>
          ) : (
            <View style={[styles.form, styles.formCentered]}>
              <OtpInput key={otpKey} onComplete={handleOtpComplete} disabled={loading} />
              <Button
                label="Renvoyer le code"
                variant="ghost"
                loading={loading}
                onPress={handleResend}
              />
              <Button
                label="Changer de numéro"
                variant="ghost"
                onPress={handleRetour}
              />
              <Button
                label="Besoin d'aide ? Contactez le support"
                variant="ghost"
                onPress={() => Linking.openURL('https://wa.me/16094454809')}
              />
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: p.background },
    kav: { flex: 1 },
    content: { flex: 1, padding: spacing[6], gap: spacing[8], justifyContent: 'center' },
    header: { gap: spacing[3] },
    back: { alignSelf: 'flex-start', marginBottom: spacing[1] },
    sub: { lineHeight: 22 },
    form:        { gap: spacing[4] },
    formCentered: { alignItems: 'center' },
    errorBox: {
      backgroundColor: p.warningLight,
      borderRadius: radius.md,
      padding: spacing[3],
    },
    errorText: { color: p.warning },
  });
}
