import { useEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from '@/src/components/ui/Button';
import { OtpInput } from '@/src/components/ui/OtpInput';
import { Text } from '@/src/components/ui/Text';
import { PhoneInput } from '@/src/components/ui/PhoneInput';
import { useTheme, radius, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';

export default function MilestonePhoneScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const { createPhoneVerification, verifyPhoneCode, upgradePhone, loading, error, clearError } = useAuthStore();
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [phone, setPhone] = useState('');
  const [phoneComplete, setPhoneComplete] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const verificationIdRef = useRef('');
  const phoneRef = useRef('');

  useEffect(() => { clearError(); }, []);

  const handleContinuer = async () => {
    clearError();
    const normalized = phone.trim().replace(/\s/g, '');
    if (!normalized) return;
    const result = await createPhoneVerification(normalized);
    if (result) {
      verificationIdRef.current = result.verificationId;
      phoneRef.current = normalized;
      setStep('otp');
    }
  };

  const handleOtpComplete = async (code: string) => {
    const ok = await verifyPhoneCode(phoneRef.current, code, verificationIdRef.current);
    if (ok) {
      await upgradePhone(phoneRef.current);
      if (!useAuthStore.getState().error) {
        router.back();
      }
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.kav}
      >
        <View style={styles.content}>
          <View style={styles.header}>
            <Text variant="display" color="brand" style={styles.logo}>patron</Text>
            <Text variant="h2" style={styles.title}>
              {step === 'phone' ? 'Sauvegardez vos données' : 'Entrez votre code'}
            </Text>
            <Text variant="body" color="secondary" style={styles.sub}>
              {step === 'phone'
                ? 'Vérifiez votre numéro pour sécuriser votre commerce. Aucun SMS payant — tout se fait via WhatsApp.'
                : 'Votre code Patron a été envoyé par WhatsApp. Il est valable 10 min.'}
            </Text>
          </View>

          {error === 'PHONE_EXISTS' ? (
            <View style={styles.errorBox}>
              <Text variant="bodySmall" color="danger" style={{ marginBottom: spacing[3] }}>
                Ce numéro est déjà associé à un compte. Connectez-vous plutôt.
              </Text>
              <Button
                label="Se connecter"
                onPress={() => { clearError(); router.replace('/(welcome)/connexion'); }}
                fullWidth
              />
            </View>
          ) : error ? (
            <View style={styles.warningBox}>
              <Text variant="bodySmall" style={styles.warningText}>{error}</Text>
            </View>
          ) : null}

          {step === 'phone' ? (
            <View style={styles.form}>
              <PhoneInput
                label="Votre numéro WhatsApp"
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
              <OtpInput onComplete={handleOtpComplete} disabled={loading} />
              <Button
                label="Changer de numéro"
                variant="ghost"
                onPress={() => {
                  clearError();
                  setStep('phone');
                  setResetKey(k => k + 1);
                  verificationIdRef.current = '';
                  phoneRef.current = '';
                }}
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
    content: { flex: 1, padding: spacing[6], justifyContent: 'center', gap: spacing[8] },
    header: { alignItems: 'center', gap: spacing[3] },
    logo: { letterSpacing: -1 },
    title: { textAlign: 'center' },
    sub: { textAlign: 'center', lineHeight: 22 },
    form: { gap: spacing[5] },
    formCentered: { alignItems: 'center' },
    errorBox: {
      backgroundColor: p.dangerLight,
      borderRadius: radius.md,
      padding: spacing[3],
    },
    warningBox: {
      backgroundColor: p.warningLight,
      borderRadius: radius.md,
      padding: spacing[3],
    },
    warningText: { color: p.warning },
  });
}
