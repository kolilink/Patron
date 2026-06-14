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
import { Input } from '@/src/components/ui/Input';
import { OtpInput } from '@/src/components/ui/OtpInput';
import { Text } from '@/src/components/ui/Text';
import { PhoneInput } from '@/src/components/ui/PhoneInput';
import { useTheme, radius, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';

type Step = 'phone' | 'otp' | 'code';

export default function RejoindreScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const { createPhoneVerification, verifyPhoneCode, upgradePhone, joinBusiness, loading, error, clearError } = useAuthStore();
  const memberships = useAuthStore(s => s.session?.memberships) ?? [];
  const joinedCount = memberships.filter(m => m.role !== 'administrateur').length;
  const joinLimitReached = joinedCount >= 3;
  const hasPhone = Boolean(useAuthStore.getState().session?.user.phone);
  const [step, setStep] = useState<Step>(hasPhone ? 'code' : 'phone');
  const [phone, setPhone] = useState('');
  const [phoneComplete, setPhoneComplete] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [otpKey, setOtpKey]     = useState(0);
  const [inviteCode, setInviteCode] = useState('');

  const verificationIdRef = useRef('');
  const phoneRef = useRef('');

  const handleJoin = async () => {
    clearError();
    const code = inviteCode.trim();
    if (!code) return;
    await joinBusiness(code);
    if (!useAuthStore.getState().error) {
      router.replace('/(app)/(tabs)/');
    }
  };

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
        setStep('code');
      }
    } else {
      setOtpKey(k => k + 1);
    }
  };

  const handleResendRejoindre = async () => {
    clearError();
    setOtpKey(k => k + 1);
    const result = await createPhoneVerification(phoneRef.current);
    if (result) verificationIdRef.current = result.verificationId;
  };

  const TITLES: Record<Step, string> = {
    phone: 'Votre numéro',
    otp: 'Entrez votre code',
    code: "Code d'invitation",
  };

  const SUBS: Record<Step, string> = {
    phone: 'Votre responsable vous a partagé un code. Vérifiez votre identité pour y accéder.',
    otp: 'Votre code Patron a été envoyé par SMS. Il est valable 30 min.',
    code: 'Entrez le code partagé par votre partenaire pour rejoindre son commerce :)',
  };

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
              onPress={() => {
                if (step === 'code') { clearError(); setStep('otp'); return; }
                if (step === 'otp') { clearError(); setStep('phone'); setResetKey(k => k + 1); verificationIdRef.current = ''; phoneRef.current = ''; return; }
                router.back();
              }}
              style={styles.back}
            />
            <Text variant="h2">{TITLES[step]}</Text>
            <Text variant="body" color="secondary" style={styles.sub}>{SUBS[step]}</Text>
          </View>

          {error === 'PHONE_EXISTS' ? (
            <View style={styles.errorBox}>
              <Text variant="bodySmall" color="danger" style={{ marginBottom: spacing[3] }}>
                Ce numéro est déjà associé à un compte. Connectez-vous d'abord.
              </Text>
              <Button
                label="Se connecter"
                onPress={() => { clearError(); router.replace('/(welcome)/connexion'); }}
                fullWidth
              />
            </View>
          ) : error ? (
            <View style={styles.errorBox}>
              <Text variant="bodySmall" color="danger">{error}</Text>
            </View>
          ) : null}

          {step === 'phone' && (
            <View style={styles.form}>
              <PhoneInput
                label="Votre numéro"
                onChange={(e164, complete) => { setPhone(e164); setPhoneComplete(complete); }}
                autoFocus
                resetKey={resetKey}
              />
              <Button label="Continuer" loading={loading} onPress={handleContinuer} fullWidth size="lg" disabled={!phoneComplete} />
            </View>
          )}

          {step === 'otp' && (
            <View style={[styles.form, styles.formCentered]}>
              <OtpInput key={otpKey} onComplete={handleOtpComplete} disabled={loading} />
              <Button label="Renvoyer le code" variant="ghost" loading={loading} onPress={handleResendRejoindre} />
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

          {step === 'code' && (
            joinLimitReached ? (
              <View style={styles.lockedBox}>
                <Text variant="body" style={styles.lockedText}>
                  Vous avez rejoint 3 commerces.
                </Text>
                <Text variant="bodySmall" color="secondary" style={{ textAlign: 'center' }}>
                  Bientôt, vous pourrez en rejoindre davantage depuis Patron.
                </Text>
              </View>
            ) : (
              <View style={styles.form}>
                <Input
                  label="Code d'invitation"
                  value={inviteCode}
                  onChangeText={v => setInviteCode(v.toUpperCase())}
                  placeholder="MANGO-47"
                  autoCapitalize="characters"
                  autoCorrect={false}
                  returnKeyType="done"
                  onSubmitEditing={handleJoin}
                  autoFocus
                />
                <Button label="Rejoindre" loading={loading} onPress={handleJoin} fullWidth size="lg" />
              </View>
            )
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
    form: { gap: spacing[4] },
    formCentered: { alignItems: 'center' },
    errorBox: { backgroundColor: p.dangerLight, borderRadius: radius.md, padding: spacing[3] },
    lockedBox: {
      backgroundColor: p.surface,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: p.border,
      padding: spacing[5],
      gap: spacing[2],
      alignItems: 'center',
    },
    lockedText: { textAlign: 'center', fontWeight: '600' },
  });
}
