import { useEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '@/src/components/ui/Screen';
import { Button } from '@/src/components/ui/Button';
import { OtpInput } from '@/src/components/ui/OtpInput';
import { Text } from '@/src/components/ui/Text';
import { PhoneInput } from '@/src/components/ui/PhoneInput';
import { BusinessDetailsStep } from '@/src/components/BusinessDetailsStep';
import { useTheme, spacing, radius } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { trackEvent, classifyAuthError } from '@/lib/analytics';
import { useCountdown } from '@/src/hooks/useCountdown';
import { formatCountdown } from '@/src/utils/format';
import { inferCurrency } from '@/src/constants/currency';
import { openWhatsApp, openSupportChat } from '@/src/utils/whatsapp';

const OTP_VALIDITY_SECONDS = 600;
const RESEND_COOLDOWN_SECONDS = 60;

type Step = 'phone' | 'otp' | 'details';
// Order the 3 real screens appear in — drives both the "Étape X sur 3"
// count and the progress bar. Never rendered at 0/3: the phone screen
// itself is step 1 of 3, not "0% done" (a field-tested progress-bar
// finding — pre-stamp what's already true instead of starting empty).
const STEP_ORDER: Step[] = ['phone', 'otp', 'details'];

export default function CreerScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const { createPhoneVerification, verifyPhoneCode, upgradePhone, createBusiness, loading, error, clearError } = useAuthStore();
  const { prefillPhone } = useLocalSearchParams<{ prefillPhone?: string }>();
  const hasPhone = Boolean(useAuthStore.getState().session?.user.phone);
  const [step, setStep] = useState<Step>(hasPhone ? 'details' : 'phone');
  const stepIndex = STEP_ORDER.indexOf(step);
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
    } else {
      trackEvent('auth_phone_submit_failed', null, null, {
        reason: classifyAuthError(useAuthStore.getState().error),
      });
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
      trackEvent('auth_failed', null, null, {
        reason: classifyAuthError(useAuthStore.getState().error),
      });
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
    phone: 'Nous vous enverrons un code pour vérifier ce numéro.',
    otp: otpValidity.secondsLeft > 0
      ? 'Votre code a été envoyé sur WhatsApp.'
      : 'Le code a expiré. Demandez-en un nouveau ci-dessous',
    details: 'Pour commencer donnez un nom à votre commerce  :)',
  };

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.kav}>
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
              <View style={styles.progress}>
                <View style={styles.progressBar}>
                  {STEP_ORDER.map((s, i) => (
                    <View
                      key={s}
                      style={[styles.progressSegment, i <= stepIndex && styles.progressSegmentFilled]}
                    />
                  ))}
                </View>
                <Text variant="caption" color="secondary">
                  Étape {stepIndex + 1} sur {STEP_ORDER.length}
                </Text>
              </View>
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
                  onChange={(e164, complete) => { setPhone(e164); setPhoneComplete(complete); }}
                  autoFocus
                  resetKey={resetKey}
                  initialValue={prefillPhone}
                  autofillOwnNumber
                />
                <Button label="Envoyer le code" loading={loading} onPress={handleContinuer} fullWidth size="lg" disabled={!phoneComplete} />
              </View>
            )}

            {step === 'otp' && (
              <View style={[styles.form, styles.formCentered]}>
                <OtpInput key={otpKey} onComplete={handleOtpComplete} disabled={loading} autoFocus whatsappAutofill />
                <Button label="Ouvrir WhatsApp" variant="ghost" onPress={openWhatsApp} />
                <Button
                  label={resendCooldown.isDone ? 'Renvoyer le code' : `Renvoyer le code (${formatCountdown(resendCooldown.secondsLeft)})`}
                  variant="ghost"
                  loading={loading}
                  disabled={!resendCooldown.isDone}
                  onPress={handleResendCreer}
                />
                <Text variant="caption" color="secondary" style={styles.antiFraud}>
                  Patron ne vous demandera jamais votre code.
                </Text>
                <Button
                  label="Changer de numéro"
                  variant="ghost"
                  onPress={() => {
                    clearError(); setStep('phone');
                    setResetKey(k => k + 1);
                    verificationIdRef.current = ''; phoneRef.current = '';
                  }}
                />
              </View>
            )}

            {step === 'details' && (
              <BusinessDetailsStep
                loading={loading}
                error={error}
                initialCurrency={inferCurrency(phoneRef.current || phone)}
                onSubmit={handleCreate}
                submitLabel="Ouvrir mon commerce"
                autoFocusName
              />
            )}

          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Kept outside the 3 step branches above so it stays visible across
          phone/OTP/business-name alike, not just on the landing screen. */}
      <Pressable style={styles.whatsappCorner} onPress={openSupportChat} hitSlop={12}>
        <Ionicons name="logo-whatsapp" size={13} color={palette.textSecondary} />
        <Text variant="caption" color="secondary">Aide</Text>
      </Pressable>
    </Screen>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    safe:          { flex: 1, backgroundColor: p.background },
    kav:           { flex: 1, backgroundColor: p.background },
    scrollContent: { flexGrow: 1 },
    content:       { flex: 1, padding: spacing[6], gap: spacing[8], justifyContent: 'center' },
    contentTop:    { justifyContent: 'flex-start', paddingBottom: spacing[10] },
    header:        { gap: spacing[3] },
    back:          { alignSelf: 'flex-start', marginBottom: spacing[1] },
    progress:      { gap: spacing[2] },
    progressBar:   { flexDirection: 'row', gap: spacing[1] },
    progressSegment: {
      flex: 1,
      height: 4,
      borderRadius: radius.full,
      backgroundColor: p.border,
    },
    progressSegmentFilled: { backgroundColor: p.primary },
    sub:           { lineHeight: 22 },
    form:          { gap: spacing[4] },
    formCentered:  { alignItems: 'center' },
    infoBlock:     { gap: spacing[3] },
    infoText:      { textAlign: 'center', lineHeight: 20 },
    antiFraud:     { textAlign: 'center' },
    whatsappCorner: {
      position: 'absolute',
      bottom: spacing[8],
      right: spacing[6],
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing[1],
    },
  });
}
