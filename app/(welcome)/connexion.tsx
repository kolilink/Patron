import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Linking,
  KeyboardAvoidingView,
  Platform,
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

export default function ConnexionScreen() {
  const { loginWithPhone, restorePhoneSession, session, loading, error, clearError } = useAuthStore();
  const [step, setStep] = useState<'phone' | 'attente'>('phone');
  const [phone, setPhone] = useState('');
  const [token, setToken] = useState('');
  const [checking, setChecking] = useState(false);
  const [notYet, setNotYet] = useState(false);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const verificationIdRef = useRef('');
  const normalizedPhoneRef = useRef('');

  useEffect(() => { clearError(); }, []);

  // Navigate once the session is restored
  useEffect(() => {
    if (!session) return;
    if (session.activeBusiness) {
      router.replace('/(app)/(tabs)/');
    } else {
      router.replace('/(app)/onboarding/');
    }
  }, [session]);

  // Realtime: fires while app is in foreground
  useEffect(() => {
    if (step !== 'attente' || !verificationIdRef.current) return;

    const channel = supabase
      .channel(`pv-login:${verificationIdRef.current}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'phone_verifications',
          filter: `id=eq.${verificationIdRef.current}`,
        },
        (payload) => {
          if ((payload.new as { status: string }).status === 'verifie') {
            restorePhoneSession(normalizedPhoneRef.current, verificationIdRef.current);
          }
        },
      )
      .subscribe();

    channelRef.current = channel;
    return () => {
      supabase.removeChannel(channel);
      channelRef.current = null;
    };
  }, [step]);

  // AppState: fires when user comes back from WhatsApp
  useEffect(() => {
    if (step !== 'attente') return;
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') checkVerificationStatus();
    });
    return () => sub.remove();
  }, [step]);

  const checkVerificationStatus = async () => {
    const id = verificationIdRef.current;
    if (!id) return;
    setChecking(true);
    setNotYet(false);
    const { data } = await supabase
      .from('phone_verifications')
      .select('status')
      .eq('id', id)
      .single();
    setChecking(false);
    if (data?.status === 'verifie') {
      restorePhoneSession(normalizedPhoneRef.current, id);
    } else {
      setNotYet(true);
    }
  };

  const handleContinuer = async () => {
    clearError();
    const normalized = phone.trim().replace(/\s/g, '');
    if (!normalized) return;
    normalizedPhoneRef.current = normalized;
    const result = await loginWithPhone(normalized);
    if (result) {
      setToken(result.token);
      verificationIdRef.current = result.verificationId;
      setStep('attente');
    }
  };

  const errorMessage = (() => {
    if (error === 'PHONE_NOT_FOUND') return "Aucun compte trouvé pour ce numéro. Créez-en un depuis l'accueil.";
    return error;
  })();

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
                if (step === 'attente') { clearError(); setStep('phone'); return; }
                router.back();
              }}
              style={styles.back}
            />
            <Text variant="h2">
              {step === 'phone' ? 'Connexion' : 'Confirmez via WhatsApp'}
            </Text>
            <Text variant="body" color="secondary" style={styles.sub}>
              {step === 'phone'
                ? 'Entrez votre numéro WhatsApp pour accéder à votre compte.'
                : "Appuyez sur le bouton. WhatsApp s'ouvrira avec le code déjà rempli. Envoyez simplement le message."}
            </Text>
          </View>

          {errorMessage ? (
            <View style={styles.errorBox}>
              <Text variant="bodySmall" color="danger">{errorMessage}</Text>
            </View>
          ) : null}

          {step === 'phone' ? (
            <View style={styles.form}>
              <Input
                label="Votre numéro WhatsApp"
                value={phone}
                onChangeText={setPhone}
                placeholder="+224, +33, +1..."
                keyboardType="phone-pad"
                returnKeyType="done"
                onSubmitEditing={handleContinuer}
                autoFocus
              />
              <Button
                label="Continuer"
                loading={loading}
                onPress={handleContinuer}
                fullWidth
                size="lg"
              />
            </View>
          ) : (
            <View style={styles.form}>
              <View style={styles.tokenBox}>
                <Text variant="label" color="secondary" style={styles.tokenLabel}>
                  Votre code de vérification
                </Text>
                <Text variant="h2" style={styles.tokenText}>{token}</Text>
              </View>

              <Button
                label="Ouvrir WhatsApp"
                onPress={() =>
                  Linking.openURL(`https://wa.me/${TWILIO_WHATSAPP_NUMBER}?text=${encodeURIComponent(token)}`)
                }
                fullWidth
                size="lg"
              />

              <Button
                label="J'ai envoyé le message →"
                variant="secondary"
                onPress={checkVerificationStatus}
                loading={checking || loading}
                fullWidth
              />

              {notYet ? (
                <Text variant="bodySmall" color="secondary" style={{ textAlign: 'center' }}>
                  Message pas encore reçu — patientez quelques secondes puis réessayez.
                </Text>
              ) : null}

              <View style={styles.waitingRow}>
                <ActivityIndicator size="small" color={palette.primary} />
                <Text variant="body" color="secondary">En attente de confirmation…</Text>
              </View>

              <Button
                label="Changer de numéro"
                variant="ghost"
                onPress={() => {
                  clearError();
                  setStep('phone');
                  setToken('');
                  setNotYet(false);
                  verificationIdRef.current = '';
                  normalizedPhoneRef.current = '';
                  if (channelRef.current) {
                    supabase.removeChannel(channelRef.current);
                    channelRef.current = null;
                  }
                }}
              />
              <Button
                label="Besoin d'aide ? Contactez le support"
                variant="ghost"
                onPress={() => Linking.openURL('https://wa.me/12672421843')}
              />
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
  errorBox: {
    backgroundColor: palette.dangerLight,
    borderRadius: radius.md,
    padding: spacing[3],
  },
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
  waitingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[3],
  },
});
