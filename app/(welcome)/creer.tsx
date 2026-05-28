import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from '@/src/components/ui/Button';
import { Input } from '@/src/components/ui/Input';
import { Text } from '@/src/components/ui/Text';
import { colors, palette, radius, spacing } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { supabase } from '@/lib/supabase';

const TWILIO_WHATSAPP_NUMBER = '14155238886';
const CURRENCIES = ['GNF', 'XOF'];

type Step = 'phone' | 'attente' | 'details';

export default function CreerScreen() {
  const { createPhoneVerification, upgradePhone, createBusiness, loading, error, clearError } = useAuthStore();
  const hasPhone = Boolean(useAuthStore.getState().session?.user.phone);
  const [step, setStep] = useState<Step>(hasPhone ? 'details' : 'phone');
  const [phone, setPhone] = useState('');
  const [token, setToken] = useState('');
  const [checking, setChecking] = useState(false);
  const [notYet, setNotYet] = useState(false);
  const [businessName, setBusinessName] = useState('');
  const [currency, setCurrency] = useState('GNF');

  const verificationIdRef = useRef('');
  const phoneRef = useRef('');
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  const handleVerified = async (ph: string) => {
    await upgradePhone(ph);
    if (!useAuthStore.getState().error) {
      setStep('details');
    }
  };

  const handleCreate = async () => {
    clearError();
    const name = businessName.trim();
    if (!name) return;
    await createBusiness({ name, currency });
    if (!useAuthStore.getState().error) {
      router.replace('/(app)/(tabs)/');
    }
  };

  const checkVerificationStatus = async () => {
    const id = verificationIdRef.current;
    const ph = phoneRef.current;
    if (!id || !ph) return;
    setChecking(true);
    setNotYet(false);
    const { data } = await supabase
      .from('phone_verifications')
      .select('status')
      .eq('id', id)
      .single();
    setChecking(false);
    if (data?.status === 'verifie') {
      handleVerified(ph);
    } else {
      setNotYet(true);
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
    return () => { supabase.removeChannel(channel); channelRef.current = null; };
  }, [step]);

  useEffect(() => {
    if (step !== 'attente') return;
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') checkVerificationStatus();
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
    }
  };

  const TITLES: Record<Step, string> = {
    phone: 'Votre numéro WhatsApp',
    attente: 'Confirmez via WhatsApp',
    details: 'Votre commerce',
  };

  const SUBS: Record<Step, string> = {
    phone: 'Pas de mot de passe à retenir. Votre WhatsApp est votre identité.',
    attente: "Appuyez sur le bouton, WhatsApp s'ouvre avec le code déjà rempli. Envoyez simplement le message.",
    details: 'Donnez un nom à votre commerce pour commencer.',
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.kav}>
        <View style={styles.content}>
          <View style={styles.header}>
            <Button
              label="← Retour"
              variant="ghost"
              onPress={() => {
                if (step === 'details') { clearError(); setStep('attente'); return; }
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
                Ce numéro est déjà associé à un compte. Connectez-vous plutôt.
              </Text>
              <Button label="Se connecter" onPress={() => { clearError(); router.replace('/(welcome)/connexion'); }} fullWidth />
            </View>
          ) : error ? (
            <View style={styles.errorBox}>
              <Text variant="bodySmall" color="danger">{error}</Text>
            </View>
          ) : null}

          {step === 'phone' && (
            <View style={styles.form}>
              <Input
                label="Numéro WhatsApp"
                value={phone}
                onChangeText={setPhone}
                placeholder="+224, +33, +1..."
                keyboardType="phone-pad"
                returnKeyType="done"
                onSubmitEditing={handleContinuer}
                autoFocus
              />
              <Button label="Continuer" loading={loading} onPress={handleContinuer} fullWidth size="lg" />
            </View>
          )}

          {step === 'attente' && (
            <View style={styles.form}>
              <View style={styles.tokenBox}>
                <Text variant="label" color="secondary" style={styles.tokenLabel}>Votre code de vérification</Text>
                <Text variant="h2" style={styles.tokenText}>{token}</Text>
              </View>
              <Button
                label="Ouvrir WhatsApp"
                onPress={() => Linking.openURL(`https://wa.me/${TWILIO_WHATSAPP_NUMBER}?text=${encodeURIComponent(token)}`)}
                fullWidth size="lg"
              />
              <Button label="J'ai envoyé le message →" variant="secondary" onPress={checkVerificationStatus} loading={checking || loading} fullWidth />
              {notYet && (
                <Text variant="bodySmall" color="secondary" style={{ textAlign: 'center' }}>
                  Message pas encore reçu — patientez quelques secondes puis réessayez.
                </Text>
              )}
              <View style={styles.waitingRow}>
                <ActivityIndicator size="small" color={palette.primary} />
                <Text variant="body" color="secondary">En attente de confirmation…</Text>
              </View>
              <Button
                label="Changer de numéro" variant="ghost"
                onPress={() => {
                  clearError(); setStep('phone'); setToken('');
                  verificationIdRef.current = ''; phoneRef.current = '';
                  if (channelRef.current) { supabase.removeChannel(channelRef.current); channelRef.current = null; }
                }}
              />
            </View>
          )}

          {step === 'details' && (
            <View style={styles.form}>
              <Input
                label="Nom du commerce"
                value={businessName}
                onChangeText={setBusinessName}
                placeholder="Ex: Boutique Mamadou"
                autoCapitalize="words"
                returnKeyType="done"
                onSubmitEditing={handleCreate}
                autoFocus
              />
              <View style={{ gap: spacing[2] }}>
                <Text variant="label">Devise</Text>
                <View style={styles.chips}>
                  {CURRENCIES.map(c => (
                    <Pressable key={c} style={[styles.chip, currency === c && styles.chipActive]} onPress={() => setCurrency(c)}>
                      <Text variant="labelSmall" color={currency === c ? 'inverse' : 'secondary'}>{c}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
              <Button label="Créer mon commerce" loading={loading} onPress={handleCreate} fullWidth size="lg" />
            </View>
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
  chips: { flexDirection: 'row', gap: spacing[2] },
  chip: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
    borderRadius: radius.full,
    borderWidth: 1.5,
    borderColor: palette.border,
    backgroundColor: palette.surface,
  },
  chipActive: { backgroundColor: palette.primary, borderColor: palette.primary },
});
