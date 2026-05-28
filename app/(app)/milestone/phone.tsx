import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
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

// Twilio sandbox number — update to your dedicated number before production
const TWILIO_WHATSAPP_NUMBER = '14155238886';

export default function MilestonePhoneScreen() {
  const { createPhoneVerification, upgradePhone, loading, error, clearError } = useAuthStore();
  const [step, setStep] = useState<'phone' | 'attente'>('phone');
  const [phone, setPhone] = useState('');
  const [token, setToken] = useState('');
  const [verificationId, setVerificationId] = useState('');
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  // Subscribe to phone_verifications row once we have a verificationId.
  // The whatsapp-inbound-webhook Edge Function flips status → 'verifie'
  // which triggers this listener and completes the upgrade.
  useEffect(() => {
    if (step !== 'attente' || !verificationId) return;

    const channel = supabase
      .channel(`pv:${verificationId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'phone_verifications',
          filter: `id=eq.${verificationId}`,
        },
        (payload) => {
          if ((payload.new as { status: string }).status === 'verifie') {
            upgradePhone(phone.trim());
          }
        },
      )
      .subscribe();

    channelRef.current = channel;
    return () => {
      supabase.removeChannel(channel);
      channelRef.current = null;
    };
  }, [step, verificationId]);

  const handleContinuer = async () => {
    clearError();
    const normalized = phone.trim().replace(/\s/g, '');
    if (!normalized) return;
    const result = await createPhoneVerification(normalized);
    if (result) {
      setToken(result.token);
      setVerificationId(result.verificationId);
      setStep('attente');
    }
  };

  const handleOpenWhatsApp = () => {
    const url = `https://wa.me/${TWILIO_WHATSAPP_NUMBER}?text=${encodeURIComponent(token)}`;
    Linking.openURL(url);
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.kav}
      >
        <View style={styles.content}>
          <View style={styles.header}>
            <Text variant="display" color="brand" style={styles.logo}>patron</Text>
            <Text variant="h2" style={styles.title}>
              {step === 'phone' ? 'Sauvegardez vos données' : 'Confirmez via WhatsApp'}
            </Text>
            <Text variant="body" color="secondary" style={styles.sub}>
              {step === 'phone'
                ? 'Vérifiez votre numéro pour sécuriser votre commerce. Aucun SMS payant — tout se fait via WhatsApp.'
                : `Appuyez sur le bouton ci-dessous. WhatsApp s'ouvrira avec le code déjà rempli. Envoyez simplement le message.`}
            </Text>
          </View>

          {error === 'PHONE_EXISTS' ? (
            <View style={styles.errorBox}>
              <Text variant="bodySmall" color="danger" style={{ marginBottom: spacing[3] }}>
                Ce numéro est déjà associé à un compte. Connectez-vous plutôt.
              </Text>
              <Button
                label="Se connecter"
                onPress={() => {
                  clearError();
                  router.replace('/(welcome)/connexion');
                }}
                fullWidth
              />
            </View>
          ) : error ? (
            <View style={styles.errorBox}>
              <Text variant="bodySmall" color="danger">{error}</Text>
            </View>
          ) : null}

          {step === 'phone' ? (
            <View style={styles.form}>
              <Input
                label="Votre numéro WhatsApp"
                value={phone}
                onChangeText={setPhone}
                placeholder="+224 XXX XXX XXX"
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
                label="Confirmer via WhatsApp"
                onPress={handleOpenWhatsApp}
                fullWidth
                size="lg"
              />

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
                  setVerificationId('');
                  if (channelRef.current) {
                    supabase.removeChannel(channelRef.current);
                    channelRef.current = null;
                  }
                }}
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
  content: {
    flex: 1,
    padding: spacing[6],
    justifyContent: 'center',
    gap: spacing[8],
  },
  header: { alignItems: 'center', gap: spacing[3] },
  logo: { letterSpacing: -1 },
  title: { textAlign: 'center' },
  sub: { textAlign: 'center', lineHeight: 22 },

  form: { gap: spacing[5] },
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
