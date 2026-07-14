import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Button } from '@/src/components/ui/Button';
import { Input } from '@/src/components/ui/Input';
import { Text } from '@/src/components/ui/Text';
import { useTheme, radius, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { CURRENCY_LIST } from '@/src/constants/currency';

interface BusinessDetailsStepProps {
  loading: boolean;
  error: string | null;
  initialCurrency: string;
  onSubmit: (data: { name: string; currency: string; referralCode?: string }) => void;
  // Referral codes are currently only offered from the fresh-signup entry
  // point (welcome/creer.tsx) — an already-authenticated user reaching this
  // via onboarding/creer.tsx has no equivalent referral flow yet.
  showReferralCode?: boolean;
  submitLabel?: string;
  autoFocusName?: boolean;
}

// Shared "name your business + pick a currency" step, used by both a fresh
// signup (app/(welcome)/creer.tsx, after phone+OTP) and an already-verified
// session with no business yet (app/(app)/onboarding/creer.tsx). Extracted
// because the two used to be copy-pasted and had already drifted apart in
// currency-lock copy and button label.
export function BusinessDetailsStep({
  loading, error, initialCurrency, onSubmit, showReferralCode, submitLabel = 'Créer mon commerce', autoFocusName,
}: BusinessDetailsStepProps) {
  const { palette } = useTheme();
  const styles = makeStyles(palette);

  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [currency, setCurrency] = useState(initialCurrency);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [referralCode, setReferralCode] = useState('');

  const selectedC = CURRENCY_LIST.find(c => c.code === currency) ?? CURRENCY_LIST[0];

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      setNameError('Minimum 2 caractères');
      return;
    }
    setNameError(null);
    onSubmit({ name: trimmed, currency, referralCode: referralCode.trim() || undefined });
  };

  return (
    <View style={styles.form}>
      {error ? (
        <View style={styles.errorBox}>
          <Text variant="bodySmall" color="danger">{error}</Text>
        </View>
      ) : null}

      <Input
        label="Nom de votre commerce"
        value={name}
        onChangeText={t => { setName(t); if (nameError) setNameError(null); }}
        error={nameError ?? undefined}
        placeholder="Boutique Mamadou"
        autoCapitalize="words"
        returnKeyType="done"
        onSubmitEditing={handleSubmit}
        autoFocus={autoFocusName}
      />

      {/* Currency — collapsed pill, tap to expand */}
      <View style={styles.section}>
        <Text variant="label">Monnaie</Text>

        <Pressable style={styles.currencyTrigger} onPress={() => setPickerOpen(v => !v)}>
          <Text style={styles.currencyFlag}>{selectedC.flag}</Text>
          <View style={{ flex: 1 }}>
            <Text variant="label" style={{ color: palette.primary }}>{selectedC.name}</Text>
            <Text variant="caption" color="secondary">{selectedC.sub}</Text>
          </View>
          <Ionicons name={pickerOpen ? 'chevron-up' : 'chevron-down'} size={18} color={palette.primary} />
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

      {showReferralCode && (
        <Input
          label="Code de parrainage (optionnel)"
          value={referralCode}
          onChangeText={t => setReferralCode(t.toUpperCase())}
          placeholder="Ex : AB12CD"
          autoCapitalize="characters"
          autoCorrect={false}
          returnKeyType="done"
          onSubmitEditing={handleSubmit}
        />
      )}

      <Button label={submitLabel} loading={loading} onPress={handleSubmit} fullWidth size="lg" />
    </View>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    form:    { gap: spacing[4] },
    section: { gap: spacing[3] },
    errorBox: { backgroundColor: p.dangerLight, borderRadius: radius.md, padding: spacing[3] },

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
