import { useEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Screen } from '@/src/components/ui/Screen';
import { Button } from '@/src/components/ui/Button';
import { OtpInput } from '@/src/components/ui/OtpInput';
import { Text } from '@/src/components/ui/Text';
import { PhoneInput } from '@/src/components/ui/PhoneInput';
import { BusinessDetailsStep } from '@/src/components/BusinessDetailsStep';
import { useTheme, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useCountdown } from '@/src/hooks/useCountdown';
import { formatCountdown } from '@/src/utils/format';
import { inferCurrency } from '@/src/constants/currency';

const SUPPORT_WA_URL = `https://wa.me/16094454809?text=${encodeURIComponent("Bonjour ! J'ai une question sur Patron 🙂")}`;

const OTP_VALIDITY_SECONDS = 600;
const RESEND_COOLDOWN_SECONDS = 60;

type Step = 'phone' | 'otp' | 'details';

export default function CreerScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const { createPhoneVerification, verifyPhoneCode, upgradePhone, createBusiness, loading, error, clearError } = useAuthStore();
  const { prefillPhone } = useLocalSearchParams<{ prefillPhone?: string }>();
  const hasPhone = Boolean(useAuthStore.getState().session?.user.phone);
  const [step, setStep] = useState<Step>(hasPhone ? 'details' : 'phone');
  const [phone, setPhone] = useState('');
  const [phoneComplete, setPhoneComplete] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [otpKey, setOtpKey]     = useState(0);

  const verificationIdRef = useRef('');
  const phoneRef = useRef('');
  const otpValidity = useCountdown();
  const resendCooldown = useCountdown();

  const handleCreate = async (data: { name: string; currency: string }) => {
    clearError();
    await createBusiness({ name: data.name, currency: data.currency });
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
      otpValidity.start(OTP_VALIDITY_SECONDS);
      resendCooldown.start(RESEND_COOLDOWN_SECONDS);
    }
  };

  const handleOtpComplete = async (code: string) => {
    const ok = await verifyPhoneCode(phoneRef.current, code, verificationIdRef.current);
    if (ok) {
      await upgradePhone(phoneRef.current);
      if (!useAuthStore.getState().error) {
        setStep('details');
      }
    } else {
      setOtpKey(k => k + 1);
    }
  };

  const handleResendCreer = async () => {
    if (!resendCooldown.isDone) return;
    clearError();
    setOtpKey(k => k + 1);
    const result = await createPhoneVerification(phoneRef.current);
    if (result) {
      verificationIdRef.current = result.verificationId;
      otpValidity.start(OTP_VALIDITY_SECONDS);
      resendCooldown.start(RESEND_COOLDOWN_SECONDS);
    }
  };

  const TITLES: Record<Step, string> = {
    phone: 'Votre numéro',
    otp: 'Entrez votre code',
    details: 'Votre commerce',
  };

  const SUBS: Record<Step, string> = {
    phone: 'Entrez votre numéro, on vous enverra un code',
    otp: otpValidity.secondsLeft > 0
      ? `Votre code Patron a été envoyé par WhatsApp. Valable encore pour ${formatCountdown(otpValidity.secondsLeft)}`
      : 'Le code a expiré. Demandez-en un nouveau ci-dessous',
    details: 'Pour commencer donnez un nom à votre commerce  :)',
  };

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.kav}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={[styles.content, step === 'details' && styles.contentTop]}>

            <View style={styles.header}>
              <Button
                label="← Retour"
                variant="ghost"
                onPress={() => {
                  if (step === 'details') { clearError(); setStep('otp'); return; }
                  if (step === 'otp') { clearError(); setStep('phone'); setResetKey(k => k + 1); verificationIdRef.current = ''; phoneRef.current = ''; return; }
                  router.back();
                }}
                style={styles.back}
              />
              <Text variant="h2">{TITLES[step]}</Text>
              <Text variant="body" color="secondary" style={styles.sub}>{SUBS[step]}</Text>
            </View>

            {step !== 'details' && (
              error === 'PHONE_EXISTS' ? (
                <View style={styles.infoBlock}>
                  <Text variant="bodySmall" color="secondary" style={styles.infoText}>
                    Ce numéro a déjà un compte
                  </Text>
                  <Button
                    label="Se connecter"
                    variant="secondary"
                    onPress={() => { clearError(); router.replace({ pathname: '/(welcome)/connexion', params: { prefillPhone: phone } }); }}
                    fullWidth
                  />
                </View>
              ) : error ? (
                <Text variant="bodySmall" color="secondary" style={styles.infoText}>{error}</Text>
              ) : null
            )}

            {step === 'phone' && (
              <View style={styles.form}>
                <PhoneInput
                  label="Votre numéro"
                  onChange={(e164, complete) => { setPhone(e164); setPhoneComplete(complete); }}
                  autoFocus
                  resetKey={resetKey}
                  initialValue={prefillPhone}
                  autofillOwnNumber
                />
                <Button label="Continuer" loading={loading} onPress={handleContinuer} fullWidth size="lg" disabled={!phoneComplete} />
              </View>
            )}

            {step === 'otp' && (
              <View style={[styles.form, styles.formCentered]}>
                <OtpInput key={otpKey} onComplete={handleOtpComplete} disabled={loading} autoFocus whatsappAutofill />
                <Button
                  label={resendCooldown.isDone ? 'Renvoyer le code' : `Renvoyer le code (${formatCountdown(resendCooldown.secondsLeft)})`}
                  variant="ghost"
                  loading={loading}
                  disabled={!resendCooldown.isDone}
                  onPress={handleResendCreer}
                />
                <Button
                  label="Changer de numéro"
                  variant="ghost"
                  onPress={() => {
                    clearError(); setStep('phone');
                    setResetKey(k => k + 1);
                    verificationIdRef.current = ''; phoneRef.current = '';
                  }}
                />
                <Button
                  label="Besoin d'aide ? Contactez le support"
                  variant="ghost"
                  onPress={() => Linking.openURL(SUPPORT_WA_URL)}
                />
              </View>
            )}

            {step === 'details' && (
              <BusinessDetailsStep
                loading={loading}
                error={error}
                initialCurrency={inferCurrency(phoneRef.current || phone)}
                onSubmit={handleCreate}
                autoFocusName
              />
            )}

          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    safe:          { flex: 1, backgroundColor: p.background },
    kav:           { flex: 1 },
    scrollContent: { flexGrow: 1 },
    content:       { flex: 1, padding: spacing[6], gap: spacing[8], justifyContent: 'center' },
    contentTop:    { justifyContent: 'flex-start', paddingBottom: spacing[10] },
    header:        { gap: spacing[3] },
    back:          { alignSelf: 'flex-start', marginBottom: spacing[1] },
    sub:           { lineHeight: 22 },
    form:          { gap: spacing[4] },
    formCentered:  { alignItems: 'center' },
    infoBlock:     { gap: spacing[3] },
    infoText:      { textAlign: 'center', lineHeight: 20 },
  });
}
