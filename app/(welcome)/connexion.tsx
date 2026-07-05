import { useEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Linking,
  Platform,
  StyleSheet,
  View,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Screen } from '@/src/components/ui/Screen';
import { Button } from '@/src/components/ui/Button';
import { OtpInput } from '@/src/components/ui/OtpInput';
import { Text } from '@/src/components/ui/Text';
import { PhoneInput } from '@/src/components/ui/PhoneInput';
import { useTheme, radius, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { trackEvent } from '@/lib/analytics';
import { useCountdown } from '@/src/hooks/useCountdown';
import { formatCountdown } from '@/src/utils/format';
import { getKV, setKV } from '@/lib/db';

const OTP_VALIDITY_SECONDS = 600;
const RESEND_COOLDOWN_SECONDS = 60;
const LAST_PHONE_KEY = 'last_login_phone';

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
  const otpValidity               = useCountdown();
  const resendCooldown            = useCountdown();

  const { autoOtp, prefillPhone } = useLocalSearchParams<{ autoOtp?: string; prefillPhone?: string }>();
  const [initialPhone, setInitialPhone] = useState(prefillPhone);
  const [phoneLoadKey, setPhoneLoadKey] = useState(0);

  useEffect(() => {
    clearError();
    trackEvent('auth_login_screen_viewed', null, null);
    if (prefillPhone) return;
    getKV(LAST_PHONE_KEY).then(saved => {
      if (saved) { setInitialPhone(saved); setPhoneLoadKey(k => k + 1); }
    });
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
    otpValidity.start(OTP_VALIDITY_SECONDS);
    resendCooldown.start(RESEND_COOLDOWN_SECONDS);
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
      otpValidity.start(OTP_VALIDITY_SECONDS);
      resendCooldown.start(RESEND_COOLDOWN_SECONDS);
      setKV(LAST_PHONE_KEY, normalized);
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
    if (!resendCooldown.isDone) return;
    clearError();
    setOtpKey(k => k + 1);
    const result = await loginWithPhone(normalizedPhoneRef.current);
    if (result) {
      verificationIdRef.current = result.verificationId;
      otpValidity.start(OTP_VALIDITY_SECONDS);
      resendCooldown.start(RESEND_COOLDOWN_SECONDS);
    }
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

  const errorMessage = error === 'PHONE_NOT_FOUND' ? null : error;

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
              {step === 'phone' ? 'Connexion' : 'Entrez votre code'}
            </Text>
            <Text variant="body" color="secondary" style={styles.sub}>
              {step === 'phone'
                ? 'Entrez votre numéro, on vous enverra un code'
                : otpValidity.secondsLeft > 0
                  ? `Votre code Patron a été envoyé par WhatsApp. Valable encore pour ${formatCountdown(otpValidity.secondsLeft)}`
                  : 'Le code a expiré. Demandez-en un nouveau ci-dessous'}
            </Text>
          </View>

          {error === 'PHONE_NOT_FOUND' ? (
            <View style={styles.infoBlock}>
              <Text variant="bodySmall" color="secondary" style={styles.infoText}>
                Aucun compte associé à ce numéro
              </Text>
              <Button
                label="Créer un compte"
                variant="secondary"
                onPress={() => {
                  clearError();
                  router.replace({ pathname: '/(welcome)/creer', params: { prefillPhone: normalizedPhoneRef.current || phone } });
                }}
                fullWidth
              />
            </View>
          ) : errorMessage ? (
            <Text variant="bodySmall" color="secondary" style={styles.infoText}>{errorMessage}</Text>
          ) : null}

          {step === 'phone' ? (
            <View style={styles.form}>
              <PhoneInput
                key={`${resetKey}-${phoneLoadKey}`}
                label="Votre numéro"
                onChange={(e164, complete) => { setPhone(e164); setPhoneComplete(complete); }}
                autoFocus
                resetKey={resetKey}
                initialValue={initialPhone}
                autofillOwnNumber
              />
              <Button
                label="Continuer"
                loading={loading}
                onPress={handleContinuer}
                fullWidth
                size="lg"
                disabled={!phoneComplete}
              />
              <Button
                label="Se connecter via email"
                variant="ghost"
                onPress={() => router.push('/(welcome)/recuperation')}
              />
            </View>
          ) : (
            <View style={[styles.form, styles.formCentered]}>
              <OtpInput key={otpKey} onComplete={handleOtpComplete} disabled={loading} autoFocus />
              <Button
                label={resendCooldown.isDone ? 'Renvoyer le code' : `Renvoyer le code (${formatCountdown(resendCooldown.secondsLeft)})`}
                variant="ghost"
                loading={loading}
                disabled={!resendCooldown.isDone}
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
    form:        { gap: spacing[4] },
    formCentered: { alignItems: 'center' },
    infoBlock:   { gap: spacing[3] },
    infoText:    { textAlign: 'center', lineHeight: 20 },
  });
}
