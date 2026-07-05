import { useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@/src/components/ui/Screen';
import { Button } from '@/src/components/ui/Button';
import { Input } from '@/src/components/ui/Input';
import { OtpInput } from '@/src/components/ui/OtpInput';
import { Text } from '@/src/components/ui/Text';
import { useTheme, radius, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { getKV, setKV } from '@/lib/db';

const LAST_EMAIL_KEY = 'last_login_email';

export default function RecuperationScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const { sendEmailOtp, recoverByEmail, session, loading, error, clearError } = useAuthStore();

  const [step, setStep] = useState<'email' | 'otp'>('email');
  const [email, setEmail] = useState('');
  const [otpKey, setOtpKey] = useState(0);
  const verificationIdRef = useRef('');

  useEffect(() => {
    clearError();
    getKV(LAST_EMAIL_KEY).then(saved => { if (saved) setEmail(saved); });
  }, []);

  useEffect(() => {
    if (!session) return;
    if (session.activeBusiness) {
      router.replace('/(app)/(tabs)/');
    } else {
      router.replace('/(app)/onboarding/');
    }
  }, [session]);

  const handleSendCode = async () => {
    clearError();
    const trimmed = email.trim().toLowerCase();
    if (!trimmed || !trimmed.includes('@')) return;
    const result = await sendEmailOtp(trimmed);
    if (result) {
      verificationIdRef.current = result.verificationId;
      setStep('otp');
      setKV(LAST_EMAIL_KEY, trimmed);
    }
  };

  const handleOtpComplete = async (code: string) => {
    await recoverByEmail(email.trim().toLowerCase(), code, verificationIdRef.current);
  };

  const handleResend = async () => {
    clearError();
    setOtpKey(k => k + 1);
    const result = await sendEmailOtp(email.trim().toLowerCase());
    if (result) verificationIdRef.current = result.verificationId;
  };

  const handleRetour = () => {
    if (step === 'otp') {
      clearError();
      setStep('email');
      verificationIdRef.current = '';
      return;
    }
    router.back();
  };

  return (
    <Screen>
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
              {step === 'email' ? 'Se connecter via email' : 'Entrez votre code'}
            </Text>
            <Text variant="body" color="secondary" style={styles.sub}>
              {step === 'email'
                ? 'Entrez votre email, on vous enverra un code.'
                : `Un code à 6 chiffres est arrivé à ${email.trim().toLowerCase()}`}
            </Text>
          </View>

          {error ? (
            <View style={styles.errorBox}>
              <Text variant="bodySmall" style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          {step === 'email' ? (
            <View style={styles.form}>
              <Input
                label="Email"
                value={email}
                onChangeText={setEmail}
                placeholder="vous@exemple.com"
                keyboardType="email-address"
                textContentType="emailAddress"
                autoComplete="email"
                autoCapitalize="none"
                returnKeyType="done"
                onSubmitEditing={handleSendCode}
                autoFocus
              />
              <Button
                label="Envoyer le code"
                loading={loading}
                onPress={handleSendCode}
                fullWidth
                size="lg"
                disabled={!email.trim().includes('@')}
              />
            </View>
          ) : (
            <View style={[styles.form, styles.formCentered]}>
              <OtpInput key={otpKey} onComplete={handleOtpComplete} disabled={loading} autoFocus />
              <Button
                label="Renvoyer le code"
                variant="ghost"
                loading={loading}
                onPress={handleResend}
              />
              <Button
                label="Changer d'email"
                variant="ghost"
                onPress={handleRetour}
              />
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
    </Screen>
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
    form: { gap: spacing[4] },
    formCentered: { alignItems: 'center' },
    errorBox: {
      backgroundColor: p.warningLight,
      borderRadius: radius.md,
      padding: spacing[3],
    },
    errorText: { color: p.warning },
  });
}
