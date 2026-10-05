import { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing, radius } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { haptics } from '@/lib/haptics';
import { minorUnits } from '@/src/utils/format';
import type { KeypadKey } from '@/src/utils/expenseUtils';

// Calculator keypad: numeric-first, no OS keyboard. Whole-unit currencies get a
// "000" key (GNF thousands); currencies with decimals get a separator instead.
export function ExpenseKeypad({ currency, onKey }: { currency: string; onKey: (k: KeypadKey) => void }) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const wholeUnit = minorUnits(currency) === 0;
  const rows: (KeypadKey)[][] = [
    ['1', '2', '3'],
    ['4', '5', '6'],
    ['7', '8', '9'],
    [wholeUnit ? '000' : 'dot', '0', 'back'],
  ];
  return (
    <View style={styles.pad}>
      {rows.map((row, i) => (
        <View key={i} style={styles.row}>
          {row.map(k => (
            <Pressable
              key={k}
              onPress={() => { haptics.tap(); onKey(k); }}
              style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
              accessibilityRole="button"
              accessibilityLabel={k === 'back' ? 'Effacer' : k === 'dot' ? 'Virgule' : k}
            >
              {k === 'back'
                ? <Ionicons name="backspace-outline" size={26} color={palette.textPrimary} />
                : <Text variant="h3" style={{ color: palette.textPrimary }}>{k === 'dot' ? ',' : k}</Text>}
            </Pressable>
          ))}
        </View>
      ))}
    </View>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    pad: { gap: spacing[2] },
    row: { flexDirection: 'row', gap: spacing[2] },
    key: {
      flex: 1, height: 56, alignItems: 'center', justifyContent: 'center',
      borderRadius: radius.lg, backgroundColor: p.surface, borderWidth: 1, borderColor: p.border,
    },
    keyPressed: { backgroundColor: p.border },
  });
}
