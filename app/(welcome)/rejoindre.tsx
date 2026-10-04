import { useEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@/src/components/ui/Screen';
import { Button } from '@/src/components/ui/Button';
import { OtpInput } from '@/src/components/ui/OtpInput';
import { Text } from '@/src/components/ui/Text';
import { PhoneInput } from '@/src/components/ui/PhoneInput';
import { useCountdown } from '@/src/hooks/useCountdown';
import { formatCountdown } from '@/src/utils/format';
import { JoinCodeStep } from '@/src/components/JoinCodeStep';
import { useTheme, radius, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useInviterStore } from '@/stores/inviter';
import { getPendingInviteToken, clearPendingInviteToken } from '@/lib/inviteLink';
import { trackEvent, classifyAuthError } from '@/lib/analytics';
import { openWhatsApp } from '@/src/utils/whatsapp';

type Step = 'phone' | 'otp' | 'code';
const RESEND_COOLDOWN_SECONDS = 60;

export default function RejoindreScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const { createPhoneVerification, verifyPhoneCode, upgradePhone, joinBusiness, loading, error, clearError } = useAuthStore();
  const hasPhone = Boolean(useAuthStore.getState().session?.user.phone);
  const resendCooldown = useCountdown();
  const [step, setStep] = useState<Step>(hasPhone ? 'code' : 'phone');
  const [phone, setPhone] = useState('');
  const [phoneComplete, setPhoneComplete] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [otpKey, setOtpKey] = useState(0);

  const verificationIdRef = useRef('');
  const phoneRef = useRef('');

  const handleJoin = async (code: string) => {
    clearError();
    await joinBusiness(code);
    if (!useAuthStore.getState().error) {
      // Consume a pending consumer-invite token (Amis) carried from a deep
      // link, install referrer, or clipboard handoff — the invitee must not
      // lose the Amis landing just because they joined a business by code.
      const token = await getPendingInviteToken();
      if (token) {
        const resolved = await useInviterStore.getState().resolveInvite(token, '');
        if (resolved) {
          await clearPendingInviteToken();
          router.replace('/(app)/discussions?tab=amis');
          return;
        }
      }
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
      trackEvent('otp_sent', null, null, { flow: 'join' });
      resendCooldown.start(RESEND_COOLDOWN_SECONDS);
      setStep('otp');
    } else {
      trackEvent('auth_phone_submit_failed', null, null, {
        reason: classifyAuthError(useAuthStore.getState().error),
      });
    }
  };

  const handleOtpComplete = async (code: string) => {
    const ok = await verifyPhoneCode(phoneRef.current, code, verificationIdRef.current);
    if (ok) {
      trackEvent('otp_verified', null, null, { flow: 'join' });
      await upgradePhone(phoneRef.current);
      if (!useAuthStore.getState().error) {
        setStep('code');
      }
    } else {
      trackEvent('otp_failed', null, null, {
        flow: 'join',
        reason: classifyAuthError(useAuthStore.getState().error),
      });
      setOtpKey(k => k + 1);
    }
  };

  const handleResendRejoindre = async () => {
    if (!resendCooldown.isDone) return;
    clearError();
    setOtpKey(k => k + 1);
    const result = await createPhoneVerification(phoneRef.current);
    if (result) {
      verificationIdRef.current = result.verificationId;
      resendCooldown.start(RESEND_COOLDOWN_SECONDS);
    }
  };

  const TITLES: Record<Step, string> = {
    phone: 'Votre numéro',
    otp: 'Entrez votre code',
    code: "Code d'invitation",
  };

  const SUBS: Record<Step, string> = {
    phone: "Votre responsable vous a envoyé un code d'invitation. Vérifiez votre numéro pour rejoindre son commerce.",
    otp: 'Votre code Patron a été envoyé par WhatsApp. Il est valable pour 10 min.',
    code: 'Entrez le code partagé par votre partenaire pour rejoindre son commerce.',
  };

  return (
    <Screen>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
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

          {step !== 'code' && (
            error === 'PHONE_EXISTS' ? (
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
            ) : null
          )}

          {step === 'phone' && (
            <View style={styles.form}>
              <PhoneInput
                onChange={(e164, complete) => { setPhone(e164); setPhoneComplete(complete); }}
                autoFocus
                resetKey={resetKey}
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
                onPress={handleResendRejoindre}
              />
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
            <JoinCodeStep loading={loading} error={error} onSubmit={handleJoin} autoFocus />
          )}
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: p.background },
    kav: { flex: 1, backgroundColor: p.background },
    content: { flex: 1, padding: spacing[6], gap: spacing[8], justifyContent: 'center' },
    header: { gap: spacing[3] },
    back: { alignSelf: 'flex-start', marginBottom: spacing[1] },
    sub: { lineHeight: 22 },
    form: { gap: spacing[4] },
    formCentered: { alignItems: 'center' },
    errorBox: { backgroundColor: p.dangerLight, borderRadius: radius.md, padding: spacing[3] },
  });
}
