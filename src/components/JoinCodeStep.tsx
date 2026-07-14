import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button } from '@/src/components/ui/Button';
import { Input } from '@/src/components/ui/Input';
import { Text } from '@/src/components/ui/Text';
import { radius, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useTheme } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';

interface JoinCodeStepProps {
  loading: boolean;
  error: string | null;
  onSubmit: (code: string) => void;
  autoFocus?: boolean;
}

// Shared invite-code entry step, used by both a fresh signup
// (app/(welcome)/rejoindre.tsx, after phone+OTP) and an already-verified
// session with no business yet (app/(app)/onboarding/rejoindre.tsx). Both
// converge on the same joinBusiness() call, which already enforces the
// 3-business join cap server-side — this component surfaces that proactively
// instead of only via the generic error message after a failed attempt.
export function JoinCodeStep({ loading, error, onSubmit, autoFocus }: JoinCodeStepProps) {
  const { palette } = useTheme();
  const styles = makeStyles(palette);
  const memberships = useAuthStore(s => s.session?.memberships) ?? [];
  const joinedCount = memberships.filter(m => m.role !== 'administrateur').length;
  const joinLimitReached = joinedCount >= 3;

  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);

  if (joinLimitReached) {
    return (
      <View style={styles.lockedBox}>
        <Text variant="body" style={styles.lockedText}>Vous avez rejoint 3 commerces.</Text>
        <Text variant="bodySmall" color="secondary" style={{ textAlign: 'center' }}>
          Bientôt, vous pourrez en rejoindre davantage depuis Patron.
        </Text>
      </View>
    );
  }

  const handleSubmit = () => {
    const trimmed = code.trim();
    if (trimmed.length < 4) {
      setCodeError('Code trop court');
      return;
    }
    setCodeError(null);
    onSubmit(trimmed);
  };

  return (
    <View style={styles.form}>
      {error ? (
        <View style={styles.errorBox}>
          <Text variant="bodySmall" color="danger">{error}</Text>
        </View>
      ) : null}

      <Input
        label="Code d'invitation"
        value={code}
        onChangeText={v => { setCode(v.toUpperCase()); if (codeError) setCodeError(null); }}
        error={codeError ?? undefined}
        placeholder="MANGO-47"
        autoCapitalize="characters"
        autoCorrect={false}
        style={styles.codeInput}
        returnKeyType="done"
        onSubmitEditing={handleSubmit}
        autoFocus={autoFocus}
      />
      <Button label="Rejoindre" loading={loading} onPress={handleSubmit} fullWidth size="lg" />
    </View>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    form: { gap: spacing[4] },
    errorBox: { backgroundColor: p.dangerLight, borderRadius: radius.md, padding: spacing[3] },
    codeInput: { fontSize: 20, letterSpacing: 4, textAlign: 'center', fontWeight: '700' },
    lockedBox: {
      backgroundColor: p.surface, borderRadius: radius.md, borderWidth: 1, borderColor: p.border,
      padding: spacing[5], gap: spacing[2], alignItems: 'center',
    },
    lockedText: { textAlign: 'center', fontWeight: '600' },
  });
}
