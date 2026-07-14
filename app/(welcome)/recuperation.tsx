import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, KeyboardAvoidingView, Linking, Platform, Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { Screen } from '@/src/components/ui/Screen';
import { Button } from '@/src/components/ui/Button';
import { Input } from '@/src/components/ui/Input';
import { OtpInput } from '@/src/components/ui/OtpInput';
import { Text } from '@/src/components/ui/Text';
import { useTheme, radius, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { toast } from '@/stores/toast';
import { useCountdown } from '@/src/hooks/useCountdown';
import { formatCountdown } from '@/src/utils/format';
import { getKV, setKV } from '@/lib/db';

const LAST_EMAIL_KEY = 'last_login_email';
const RESEND_COOLDOWN_SECONDS = 60;

async function openScheme(url: string) {
  try {
    await Linking.openURL(url);
  } catch {
    toast.warning("Impossible d'ouvrir l'application mail");
  }
}

// Best-effort fallback for when we can't tell what's installed yet — either
// this build predates the LSApplicationQueriesSchemes entry needed for
// accurate iOS detection (see CLAUDE.md's Biometric-only lock note on the
// same class of native-config-needs-a-rebuild issue), or on Android, where
// the OS's own chooser already disambiguates multiple mail apps for us.
async function openMailAppFallback() {
  const candidates = Platform.OS === 'ios' ? ['googlegmail://', 'message://'] : ['mailto:'];
  for (const url of candidates) {
    try {
      await Linking.openURL(url);
      return;
    } catch {
      // try the next candidate
    }
  }
  toast.warning("Impossible d'ouvrir une application mail");
}

type MailIconSet = 'ion' | 'mdi';

function MailAppButton({
  icon,
  iconSet = 'ion',
  label,
  onPress,
  breathing,
  palette,
}: {
  icon: string;
  iconSet?: MailIconSet;
  label: string;
  onPress: () => void;
  breathing?: boolean;
  palette: Palette;
}) {
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!breathing) return;
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.5, duration: 900, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 900, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [breathing, opacity]);

  const IconComp = iconSet === 'mdi' ? MaterialCommunityIcons : Ionicons;

  return (
    <Pressable onPress={onPress} hitSlop={8}>
      {({ pressed }) => (
        <Animated.View style={[styles_mailButton.wrap, { opacity: breathing ? opacity : pressed ? 0.7 : 1 }]}>
          <View style={[styles_mailButton.circle, { borderColor: palette.border, backgroundColor: palette.surface }]}>
            <IconComp name={icon as never} size={22} color={palette.primary} />
          </View>
          <Text variant="caption" color="secondary">{label}</Text>
        </Animated.View>
      )}
    </Pressable>
  );
}

const styles_mailButton = StyleSheet.create({
  wrap:   { alignItems: 'center', gap: 6 },
  circle: { width: 48, height: 48, borderRadius: 24, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
});

export default function RecuperationScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const { sendEmailOtp, recoverByEmail, session, loading, error, clearError } = useAuthStore();

  const [step, setStep] = useState<'email' | 'otp'>('email');
  const [email, setEmail] = useState('');
  const [otpKey, setOtpKey] = useState(0);
  const verificationIdRef = useRef('');
  const resendCooldown = useCountdown();
  // iOS only — Android's mailto: intent already shows the OS's own chooser
  // when more than one mail app is installed, so no manual detection needed
  // there. null = not checked yet (still loading, or this build predates the
  // LSApplicationQueriesSchemes entry so the check can't be trusted).
  const [mailApps, setMailApps] = useState<{ gmail: boolean; mail: boolean } | null>(null);

  useEffect(() => {
    clearError();
    getKV(LAST_EMAIL_KEY).then(saved => { if (saved) setEmail(saved); });
  }, []);

  useEffect(() => {
    if (step !== 'otp' || Platform.OS !== 'ios') return;
    let cancelled = false;
    Promise.all([
      Linking.canOpenURL('googlegmail://').catch(() => false),
      Linking.canOpenURL('message://').catch(() => false),
    ]).then(([gmail, mail]) => {
      if (!cancelled) setMailApps({ gmail, mail });
    });
    return () => { cancelled = true; };
  }, [step]);

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
      resendCooldown.start(RESEND_COOLDOWN_SECONDS);
    }
  };

  const handleOtpComplete = async (code: string) => {
    await recoverByEmail(email.trim().toLowerCase(), code, verificationIdRef.current);
  };

  const handleResend = async () => {
    if (!resendCooldown.isDone) return;
    clearError();
    setOtpKey(k => k + 1);
    const result = await sendEmailOtp(email.trim().toLowerCase());
    if (result) {
      verificationIdRef.current = result.verificationId;
      resendCooldown.start(RESEND_COOLDOWN_SECONDS);
    }
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

  function renderMailShortcut() {
    if (Platform.OS !== 'ios') {
      return <MailAppButton icon="mail-outline" label="Mail" onPress={openMailAppFallback} palette={palette} />;
    }
    if (!mailApps || (!mailApps.gmail && !mailApps.mail)) {
      return <MailAppButton icon="mail-outline" label="Mail" onPress={openMailAppFallback} palette={palette} />;
    }
    if (mailApps.gmail && mailApps.mail) {
      return (
        <View style={styles.mailRow}>
          <MailAppButton icon="mail-outline" label="Mail" onPress={() => openScheme('message://')} breathing palette={palette} />
          <MailAppButton icon="gmail" iconSet="mdi" label="Gmail" onPress={() => openScheme('googlegmail://')} breathing palette={palette} />
        </View>
      );
    }
    if (mailApps.gmail) {
      return <MailAppButton icon="gmail" iconSet="mdi" label="Gmail" onPress={() => openScheme('googlegmail://')} palette={palette} />;
    }
    return <MailAppButton icon="mail-outline" label="Mail" onPress={() => openScheme('message://')} palette={palette} />;
  }

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
              {renderMailShortcut()}
              <Button
                label={resendCooldown.isDone ? 'Renvoyer le code' : `Renvoyer le code (${formatCountdown(resendCooldown.secondsLeft)})`}
                variant="ghost"
                loading={loading}
                disabled={!resendCooldown.isDone}
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
    mailRow: { flexDirection: 'row', gap: spacing[8] },
    errorBox: {
      backgroundColor: p.warningLight,
      borderRadius: radius.md,
      padding: spacing[3],
    },
    errorText: { color: p.warning },
  });
}
