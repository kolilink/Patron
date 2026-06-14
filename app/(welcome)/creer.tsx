import { useEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Button } from '@/src/components/ui/Button';
import { Input } from '@/src/components/ui/Input';
import { OtpInput } from '@/src/components/ui/OtpInput';
import { Text } from '@/src/components/ui/Text';
import { PhoneInput } from '@/src/components/ui/PhoneInput';
import { useTheme, radius, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';

const CURRENCY_LIST = [
  // West Africa
  { code: 'GNF', flag: '🇬🇳', name: 'Franc Guinéen',       sub: 'Guinée' },
  { code: 'XOF', flag: '🌍',  name: 'Franc CFA (UEMOA)',   sub: "Sénégal · Mali · Côte d'Ivoire…" },
  { code: 'XAF', flag: '🌍',  name: 'Franc CFA (CEMAC)',   sub: 'Cameroun · Congo · Gabon…' },
  { code: 'NGN', flag: '🇳🇬', name: 'Naira',               sub: 'Nigeria' },
  { code: 'GHS', flag: '🇬🇭', name: 'Cedi',                sub: 'Ghana' },
  // North Africa
  { code: 'MAD', flag: '🇲🇦', name: 'Dirham marocain',    sub: 'Maroc' },
  { code: 'DZD', flag: '🇩🇿', name: 'Dinar algérien',     sub: 'Algérie' },
  { code: 'TND', flag: '🇹🇳', name: 'Dinar tunisien',     sub: 'Tunisie' },
  { code: 'EGP', flag: '🇪🇬', name: 'Livre égyptienne',   sub: 'Égypte' },
  // East & Southern Africa
  { code: 'KES', flag: '🇰🇪', name: 'Shilling kényan',    sub: 'Kenya' },
  { code: 'ZAR', flag: '🇿🇦', name: 'Rand',               sub: 'Afrique du Sud' },
  { code: 'ETB', flag: '🇪🇹', name: 'Birr éthiopien',     sub: 'Éthiopie' },
  // Middle East
  { code: 'AED', flag: '🇦🇪', name: 'Dirham (EAU)',       sub: 'Émirats arabes unis' },
  { code: 'SAR', flag: '🇸🇦', name: 'Riyal saoudien',     sub: 'Arabie Saoudite' },
  // International
  { code: 'USD', flag: '🇺🇸', name: 'Dollar américain',   sub: 'États-Unis · diaspora…' },
  { code: 'EUR', flag: '🇪🇺', name: 'Euro',                sub: 'Europe' },
  { code: 'GBP', flag: '🇬🇧', name: 'Livre sterling',     sub: 'Royaume-Uni' },
  { code: 'CNY', flag: '🇨🇳', name: 'Yuan',               sub: 'Chine' },
  { code: 'CAD', flag: '🇨🇦', name: 'Dollar canadien',    sub: 'Canada' },
  { code: 'CHF', flag: '🇨🇭', name: 'Franc suisse',       sub: 'Suisse' },
  { code: 'INR', flag: '🇮🇳', name: 'Roupie indienne',    sub: 'Inde' },
];

// Ordered longest-prefix-first so +224 matches before +2
const PREFIX_MAP: [string, string][] = [
  ['+352', 'EUR'], // Luxembourg
  ['+971', 'AED'], // EAU
  ['+966', 'SAR'], // Arabie Saoudite
  ['+254', 'KES'], // Kenya
  ['+251', 'ETB'], // Éthiopie
  ['+224', 'GNF'], // Guinée
  ['+221', 'XOF'], // Sénégal
  ['+223', 'XOF'], // Mali
  ['+225', 'XOF'], // Côte d'Ivoire
  ['+226', 'XOF'], // Burkina Faso
  ['+227', 'XOF'], // Niger
  ['+228', 'XOF'], // Togo
  ['+229', 'XOF'], // Bénin
  ['+237', 'XAF'], // Cameroun
  ['+236', 'XAF'], // Centrafrique
  ['+241', 'XAF'], // Gabon
  ['+242', 'XAF'], // Congo Brazzaville
  ['+235', 'XAF'], // Tchad
  ['+240', 'XAF'], // Guinée équatoriale
  ['+234', 'NGN'], // Nigeria
  ['+233', 'GHS'], // Ghana
  ['+212', 'MAD'], // Maroc
  ['+213', 'DZD'], // Algérie
  ['+216', 'TND'], // Tunisie
  ['+20',  'EGP'], // Égypte
  ['+27',  'ZAR'], // Afrique du Sud
  ['+33',  'EUR'], // France
  ['+32',  'EUR'], // Belgique
  ['+41',  'CHF'], // Suisse
  ['+44',  'GBP'], // Royaume-Uni
  ['+86',  'CNY'], // Chine
  ['+91',  'INR'], // Inde
  ['+1',   'USD'], // États-Unis / Canada
];

function inferCurrency(phone: string): string {
  const available = CURRENCY_LIST.map(c => c.code);
  for (const [prefix, code] of PREFIX_MAP) {
    if (phone.startsWith(prefix) && available.includes(code)) return code;
  }
  return 'GNF';
}

type Step = 'phone' | 'otp' | 'details';

export default function CreerScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const { createPhoneVerification, verifyPhoneCode, upgradePhone, createBusiness, loading, error, clearError } = useAuthStore();
  const hasPhone = Boolean(useAuthStore.getState().session?.user.phone);
  const [step, setStep] = useState<Step>(hasPhone ? 'details' : 'phone');
  const [phone, setPhone] = useState('');
  const [phoneComplete, setPhoneComplete] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [otpKey, setOtpKey]     = useState(0);
  const [businessName, setBusinessName] = useState('');
  const [currency, setCurrency] = useState('GNF');
  const [pickerOpen, setPickerOpen] = useState(false);

  const verificationIdRef = useRef('');
  const phoneRef = useRef('');

  // Pre-select currency as soon as we have a valid phone number
  useEffect(() => {
    if (phone) setCurrency(inferCurrency(phone));
  }, [phone]);

  const selectedC = CURRENCY_LIST.find(c => c.code === currency) ?? CURRENCY_LIST[0];

  const handleCreate = async () => {
    clearError();
    const name = businessName.trim();
    if (!name) return;
    await createBusiness({ name, currency });
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
        setStep('details');
      }
    } else {
      setOtpKey(k => k + 1);
    }
  };

  const handleResendCreer = async () => {
    clearError();
    setOtpKey(k => k + 1);
    const result = await createPhoneVerification(phoneRef.current);
    if (result) verificationIdRef.current = result.verificationId;
  };

  const TITLES: Record<Step, string> = {
    phone: 'Votre numéro',
    otp: 'Entrez votre code',
    details: 'Votre commerce',
  };

  const SUBS: Record<Step, string> = {
    phone: 'Pas de mot de passe à retenir. Votre numéro est votre identité.',
    otp: 'Votre code Patron a été envoyé par SMS. Il est valable 30 min.',
    details: 'Pour commencer donnez un nom à votre commerce  :)',
  };

  return (
    <SafeAreaView style={styles.safe}>
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
                <Button label="Renvoyer le code" variant="ghost" loading={loading} onPress={handleResendCreer} />
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
              <View style={styles.form}>
                <Input
                  label="Nom de votre commerce"
                  value={businessName}
                  onChangeText={setBusinessName}
                  placeholder="Boutique Mamadou"
                  autoCapitalize="words"
                  returnKeyType="done"
                  onSubmitEditing={handleCreate}
                  autoFocus
                />

                {/* Currency — collapsed pill, tap to expand */}
                <View style={{ gap: spacing[2] }}>
                  <Text variant="label">Monnaie</Text>

                  {/* Trigger — shows selected currency */}
                  <Pressable style={styles.currencyTrigger} onPress={() => setPickerOpen(v => !v)}>
                    <Text style={styles.currencyFlag}>{selectedC.flag}</Text>
                    <View style={{ flex: 1 }}>
                      <Text variant="label" style={{ color: palette.primary }}>{selectedC.name}</Text>
                      <Text variant="caption" color="secondary">{selectedC.sub}</Text>
                    </View>
                    <Ionicons
                      name={pickerOpen ? 'chevron-up' : 'chevron-down'}
                      size={18}
                      color={palette.primary}
                    />
                  </Pressable>

                  {/* Dropdown — only visible when open */}
                  {pickerOpen && (
                    <View style={styles.currencyList}>
                      {CURRENCY_LIST.map((c, i) => {
                        const selected = currency === c.code;
                        const isLast   = i === CURRENCY_LIST.length - 1;
                        return (
                          <Pressable
                            key={c.code}
                            onPress={() => { setCurrency(c.code); setPickerOpen(false); }}
                            style={[
                              styles.currencyRow,
                              selected && styles.currencyRowSelected,
                              !isLast && styles.currencyRowBorder,
                            ]}>
                            <Text style={styles.currencyFlag}>{c.flag}</Text>
                            <View style={{ flex: 1 }}>
                              <Text variant="label" style={selected ? { color: palette.primary } : undefined}>
                                {c.name}
                              </Text>
                              <Text variant="caption" color="secondary">{c.sub}</Text>
                            </View>
                            {selected && (
                              <Ionicons name="checkmark" size={18} color={palette.primary} />
                            )}
                          </Pressable>
                        );
                      })}
                    </View>
                  )}

                  <View style={styles.lockNote}>
                    <Ionicons name="checkmark-outline" size={13} color={palette.textDisabled} />
                    <Text variant="caption" color="secondary" style={{ flex: 1 }}>
                      Ceci sera votre monnaie officielle
                    </Text>
                  </View>
                </View>

                <Button label="Créer mon commerce" loading={loading} onPress={handleCreate} fullWidth size="lg" />
              </View>
            )}

          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
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
    errorBox:      { backgroundColor: p.dangerLight, borderRadius: radius.md, padding: spacing[3] },

    currencyTrigger: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[3],
      paddingHorizontal: spacing[4], paddingVertical: spacing[3],
      backgroundColor: p.primaryLight,
      borderRadius: radius.md,
      borderWidth: 1, borderColor: p.primary + '50',
    },

    currencyList:        { borderRadius: radius.md, borderWidth: 1, borderColor: p.border, overflow: 'hidden' },
    currencyRow:         { flexDirection: 'row', alignItems: 'center', gap: spacing[3], paddingHorizontal: spacing[4], paddingVertical: spacing[3], backgroundColor: p.surface },
    currencyRowSelected: { backgroundColor: p.primaryLight },
    currencyRowBorder:   { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.border },
    currencyFlag:        { fontSize: 22, width: 30, textAlign: 'center' as const },

    lockNote: { flexDirection: 'row', alignItems: 'center', gap: spacing[2], paddingHorizontal: spacing[1] },
  });
}
