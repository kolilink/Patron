import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button } from '@/src/components/ui/Button';
import { Input } from '@/src/components/ui/Input';
import { Text } from '@/src/components/ui/Text';
import { useTheme, radius, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { CurrencyPicker } from '@/src/components/ui/CurrencyPicker';
import { haptics } from '@/lib/haptics';

interface BusinessDetailsStepProps {
  loading: boolean;
  error: string | null;
  initialCurrency: string;
  onSubmit: (data: { name: string; currency: string; referralCode?: string }) => void;
  // Referral codes are currently only offered from the fresh-signup entry
  // point (welcome/creer.tsx) — an already-authenticated user reaching this
  // via onboarding/creer.tsx has no equivalent referral flow yet.
  showReferralCode?: boolean;
  // Required, not defaulted — the two call sites are different moments
  // ("Ouvrir mon commerce" for a fresh signup vs. "Créer le commerce" for an
  // already-verified user adding another) and a shared fallback previously
  // let one of them go stale (once a stale "Créer mon commerce") without anyone
  // noticing, since there was nothing forcing a deliberate choice.
  submitLabel: string;
  autoFocusName?: boolean;
}

// Shared "name your business + pick a currency" step, used by both a fresh
// signup (app/(welcome)/creer.tsx, after phone+OTP) and an already-verified
// session with no business yet (app/(app)/onboarding/creer.tsx). Extracted
// because the two used to be copy-pasted and had already drifted apart in
// currency-lock copy and button label.
export function BusinessDetailsStep({
  loading, error, initialCurrency, onSubmit, showReferralCode, submitLabel, autoFocusName,
}: BusinessDetailsStepProps) {
  const { palette } = useTheme();
  const styles = makeStyles(palette);

  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [currency, setCurrency] = useState(initialCurrency);
  const [referralCode, setReferralCode] = useState('');

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      haptics.warning();
      setNameError('Minimum 2 caractères');
      return;
    }
    setNameError(null);
    haptics.tap();
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
        placeholder="Commerce de Mamadou"
        autoCapitalize="words"
        returnKeyType="done"
        onSubmitEditing={handleSubmit}
        autoFocus={autoFocusName}
      />

      {/* Currency — collapsed pill, tap to expand */}
      <View style={styles.section}>
        <Text variant="label">Monnaie</Text>

        <CurrencyPicker value={currency} onChange={setCurrency} />
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
      <Text variant="caption" color="secondary" style={styles.currencyNote}>
        Modifiable jusqu&apos;à votre première vente.
      </Text>
    </View>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    form: { gap: spacing[4] },
    section: { gap: spacing[3] },
    errorBox: { backgroundColor: p.dangerLight, borderRadius: radius.md, padding: spacing[3] },


    currencyNote: { textAlign: 'center' },
  });
}
