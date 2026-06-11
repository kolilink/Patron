import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  KeyboardAvoidingView,
  Linking,
  Platform,
  StyleSheet,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from '@/src/components/ui/Button';
import { Input } from '@/src/components/ui/Input';
import { Text } from '@/src/components/ui/Text';
import { PhoneInput } from '@/src/components/ui/PhoneInput';
import { colors, palette, radius, spacing } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { supabase } from '@/lib/supabase';

const TWILIO_WHATSAPP_NUMBER = '15559897763';

type Step = 'phone' | 'attente' | 'code';

export default function RejoindreScreen() {
  const { createPhoneVerification, upgradePhone, joinBusiness, loading, error, clearError } = useAuthStore();
  const memberships = useAuthStore(s => s.session?.memberships) ?? [];
  const joinedCount = memberships.filter(m => m.role !== 'administrateur').length;
  const joinLimitReached = joinedCount >= 3;
  const hasPhone = Boolean(useAuthStore.getState().session?.user.phone);
  const [step, setStep] = useState<Step>(hasPhone ? 'code' : 'phone');
  const [phone, setPhone] = useState('');
  const [phoneComplete, setPhoneComplete] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [token, setToken] = useState('');
  const [checking, setChecking] = useState(false);
  const [inviteCode, setInviteCode] = useState('');

  const verificationIdRef = useRef('');
  const phoneRef = useRef('');
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  const handleVerified = async (ph: string) => {
    await upgradePhone(ph);
    if (!useAuthStore.getState().error) {
      setStep('code');
    }
  };

  const handleJoin = async () => {
    clearError();
    const code = inviteCode.trim();
    if (!code) return;
    await joinBusiness(code);
    if (!useAuthStore.getState().error) {
      router.replace('/(app)/(tabs)/');
    }
  };

  const checkVerificationStatus = async () => {
    const id = verificationIdRef.current;
    const ph = phoneRef.current;
    if (!id || !ph) return;
    setChecking(true);
    const { data } = await supabase
      .from('phone_verifications')
      .select('status')
      .eq('id', id)
      .single();
    setChecking(false);
    if (data?.status === 'verifie') {
      handleVerified(ph);
    }
  };

  useEffect(() => {
    if (step !== 'attente' || !verificationIdRef.current) return;

    const channel = supabase
      .channel(`pv:${verificationIdRef.current}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'phone_verifications',
        filter: `id=eq.${verificationIdRef.current}`,
      }, (payload) => {
        if ((payload.new as { status: string }).status === 'verifie') {
          handleVerified(phoneRef.current);
        }
      })
      .subscribe();

    channelRef.current = channel;
    return () => {
      supabase.removeChannel(channel);
      channelRef.current = null;
    };
  }, [step]);

  // AppState: auto-check when user comes back from WhatsApp
  useEffect(() => {
    if (step !== 'attente') return;
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') checkVerificationStatus();
    });
    return () => sub.remove();
  }, [step]);

  useEffect(() => { clearError(); }, []);

  const handleContinuer = async () => {
    clearError();
    const normalized = phone.trim().replace(/\s/g, '');
    if (!normalized) return;
    const result = await createPhoneVerification(normalized);
    if (result) {
      setToken(result.token);
      verificationIdRef.current = result.verificationId;
      phoneRef.current = normalized;
      setStep('attente');
      // Immediate check — catches demo account (already verifie on insert).
      checkVerificationStatus();
    }
  };

  const TITLES: Record<Step, string> = {
    phone: 'Votre numéro WhatsApp',
    attente: 'Confirmez via WhatsApp',
    code: "Code d'invitation",
  };

  const SUBS: Record<Step, string> = {
    phone: 'Votre responsable vous a partagé un code. Vérifiez votre identité pour y accéder.',
    attente: 'Ouvrez WhatsApp et envoyez le code. On détecte automatiquement.',
    code: 'Entrez le code partagé par votre partenaire pour rejoindre son commerce :)',
  };

  return (
    <SafeAreaView style={styles.safe}>
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
                if (step === 'code') { clearError(); setStep('attente'); return; }
                if (step === 'attente') { clearError(); setStep('phone'); return; }
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
                label="Numéro WhatsApp"
                onChange={(e164, complete) => { setPhone(e164); setPhoneComplete(complete); }}
                autoFocus
                resetKey={resetKey}
              />
              <Button label="Continuer" loading={loading} onPress={handleContinuer} fullWidth size="lg" disabled={!phoneComplete} />
            </View>
          )}

          {step === 'attente' && (
            <View style={styles.form}>
              <View style={styles.tokenBox}>
                <Text variant="label" color="secondary" style={styles.tokenLabel}>
                  Votre code de vérification
                </Text>
                <Text variant="h2" style={styles.tokenText}>{token}</Text>
              </View>

              <Button
                label="Ouvrir WhatsApp"
                onPress={() => Linking.openURL(`https://wa.me/${TWILIO_WHATSAPP_NUMBER}?text=${encodeURIComponent(token)}`)}
                fullWidth
                size="lg"
              />

              <View style={styles.waitingRow}>
                <ActivityIndicator size="small" color={palette.primary} />
                <Text variant="body" color="secondary">
                  {checking ? 'Vérification en cours…' : 'En attente de confirmation…'}
                </Text>
              </View>

              <Button
                label="Changer de numéro"
                variant="ghost"
                onPress={() => {
                  clearError();
                  setStep('phone');
                  setToken('');
                  setResetKey(k => k + 1);
                  verificationIdRef.current = '';
                  phoneRef.current = '';
                  if (channelRef.current) {
                    supabase.removeChannel(channelRef.current);
                    channelRef.current = null;
                  }
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
                  placeholder="Ex: MANGO-47"
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

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.background },
  kav: { flex: 1 },
  content: { flex: 1, padding: spacing[6], gap: spacing[8], justifyContent: 'center' },
  header: { gap: spacing[3] },
  back: { alignSelf: 'flex-start', marginBottom: spacing[1] },
  sub: { lineHeight: 22 },
  form: { gap: spacing[4] },
  errorBox: { backgroundColor: palette.dangerLight, borderRadius: radius.md, padding: spacing[3] },
  tokenBox: {
    alignItems: 'center',
    backgroundColor: palette.primaryLight,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.primary[300],
    paddingVertical: spacing[5],
    paddingHorizontal: spacing[4],
    gap: spacing[2],
  },
  tokenLabel: { textTransform: 'uppercase', letterSpacing: 1 },
  tokenText: { letterSpacing: 2, color: palette.primary },
  waitingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing[3] },
  lockedBox: {
    backgroundColor: palette.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: palette.border,
    padding: spacing[5],
    gap: spacing[2],
    alignItems: 'center',
  },
  lockedText: { textAlign: 'center', fontWeight: '600' },
});
