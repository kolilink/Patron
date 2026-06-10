import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView, Platform, Pressable,
  ScrollView, StyleSheet, View,
} from 'react-native';
import { router } from 'expo-router';
import { Controller, useForm } from 'react-hook-form';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Button } from '@/src/components/ui/Button';
import { Input } from '@/src/components/ui/Input';
import { Text } from '@/src/components/ui/Text';
import { palette, radius, spacing } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';

interface CreateForm { name: string }

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
  ['+352', 'EUR'], ['+971', 'AED'], ['+966', 'SAR'],
  ['+254', 'KES'], ['+251', 'ETB'],
  ['+224', 'GNF'], ['+221', 'XOF'], ['+223', 'XOF'], ['+225', 'XOF'],
  ['+226', 'XOF'], ['+227', 'XOF'], ['+228', 'XOF'], ['+229', 'XOF'],
  ['+237', 'XAF'], ['+236', 'XAF'], ['+241', 'XAF'], ['+242', 'XAF'],
  ['+235', 'XAF'], ['+240', 'XAF'],
  ['+234', 'NGN'], ['+233', 'GHS'],
  ['+212', 'MAD'], ['+213', 'DZD'], ['+216', 'TND'],
  ['+20',  'EGP'], ['+27',  'ZAR'],
  ['+33',  'EUR'], ['+32',  'EUR'], ['+41',  'CHF'],
  ['+44',  'GBP'], ['+86',  'CNY'], ['+91',  'INR'],
  ['+1',   'USD'],
];

const CODES = CURRENCY_LIST.map(c => c.code);

function inferCurrency(phone: string | null | undefined): string {
  if (!phone) return 'GNF';
  for (const [prefix, code] of PREFIX_MAP) {
    if (phone.startsWith(prefix) && CODES.includes(code)) return code;
  }
  return 'GNF';
}

export default function CreerCommerceScreen() {
  const { createBusiness, loading, error, clearError } = useAuthStore();
  const session     = useAuthStore(s => s.session);
  const memberships = session?.memberships ?? [];
  const alreadyOwns = memberships.some(m => m.role === 'administrateur');
  const { control, handleSubmit } = useForm<CreateForm>();
  const [currency, setCurrency]   = useState(() => inferCurrency(session?.user.phone));
  const [pickerOpen, setPickerOpen] = useState(false);
  useEffect(() => {
    setCurrency(inferCurrency(session?.user.phone));
  }, [session?.user.phone]);

  const selectedC = CURRENCY_LIST.find(c => c.code === currency) ?? CURRENCY_LIST[0];

  const onSubmit = async ({ name }: CreateForm) => {
    clearError();
    await createBusiness({ name: name.trim(), currency });
    const { session: s } = useAuthStore.getState();
    if (s?.activeBusiness) router.replace('/(app)/(tabs)/');
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.kav}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">

          <View style={styles.header}>
            <Pressable onPress={() => router.back()} style={styles.backBtn}>
              <Text variant="body" color="brand">← Retour</Text>
            </Pressable>
            <Text variant="h2">Créer un commerce</Text>
            <Text variant="body" color="secondary">Vous serez automatiquement le Gérant.</Text>
          </View>

          {alreadyOwns ? (
            <View style={styles.lockedBox}>
              <Text variant="body" style={styles.lockedText}>Vous avez déjà un commerce actif.</Text>
              <Text variant="bodySmall" color="secondary">
                Bientôt, vous pourrez en gérer plusieurs depuis Patron.
              </Text>
            </View>
          ) : (
            <View style={styles.form}>
              {error ? (
                <View style={styles.errorBox}>
                  <Text variant="bodySmall" color="danger">{error}</Text>
                </View>
              ) : null}

              <Controller
                control={control}
                name="name"
                rules={{
                  required: 'Le nom du commerce est requis',
                  minLength: { value: 2, message: 'Minimum 2 caractères' },
                }}
                render={({ field, fieldState }) => (
                  <Input
                    label="Nom du commerce"
                    value={field.value}
                    onChangeText={field.onChange}
                    onBlur={field.onBlur}
                    error={fieldState.error?.message}
                    placeholder="Ex: Boutique Mamadou"
                    autoCapitalize="words"
                    returnKeyType="done"
                    onSubmitEditing={handleSubmit(onSubmit)}
                  />
                )}
              />

              {/* Currency — collapsed pill, tap to expand */}
              <View style={styles.section}>
                <Text variant="label" style={{ color: palette.textPrimary }}>Monnaie</Text>

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
                          {selected && <Ionicons name="checkmark" size={18} color={palette.primary} />}
                        </Pressable>
                      );
                    })}
                  </View>
                )}

                <View style={styles.lockNote}>
                  <Ionicons name="lock-closed-outline" size={13} color={palette.textDisabled} />
                  <Text variant="caption" color="secondary" style={{ flex: 1 }}>
                    La monnaie sera verrouillée après votre première vente.
                  </Text>
                </View>
              </View>

              <Button
                label="Créer le commerce"
                loading={loading}
                onPress={handleSubmit(onSubmit)}
                fullWidth
              />
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:    { flex: 1, backgroundColor: palette.background },
  kav:     { flex: 1 },
  content: { flexGrow: 1, padding: spacing[6], gap: spacing[8] },
  header:  { gap: spacing[2] },
  backBtn: { alignSelf: 'flex-start', marginBottom: spacing[2] },
  form:    { gap: spacing[5] },
  section: { gap: spacing[3] },

  errorBox:   { backgroundColor: palette.dangerLight, borderRadius: 8, padding: spacing[3] },
  lockedBox:  { backgroundColor: palette.surface, borderRadius: radius.md, borderWidth: 1, borderColor: palette.border, padding: spacing[5], gap: spacing[2], alignItems: 'center' },
  lockedText: { textAlign: 'center', fontWeight: '600' as const },

  currencyTrigger: {
    flexDirection: 'row', alignItems: 'center', gap: spacing[3],
    paddingHorizontal: spacing[4], paddingVertical: spacing[3],
    backgroundColor: '#EEF2FF',
    borderRadius: radius.md,
    borderWidth: 1, borderColor: palette.primary + '50',
  },
  currencyList:        { borderRadius: radius.md, borderWidth: 1, borderColor: palette.border, overflow: 'hidden' },
  currencyRow:         { flexDirection: 'row', alignItems: 'center', gap: spacing[3], paddingHorizontal: spacing[4], paddingVertical: spacing[3], backgroundColor: palette.surface },
  currencyRowSelected: { backgroundColor: '#EEF2FF' },
  currencyRowBorder:   { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border },
  currencyFlag:        { fontSize: 22, width: 30, textAlign: 'center' as const },

  lockNote: { flexDirection: 'row', alignItems: 'center', gap: spacing[2], paddingHorizontal: spacing[1] },
});
