import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/src/components/ui/Text';
import { useTheme, radius, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { CURRENCY_LIST } from '@/src/constants/currency';
import { haptics } from '@/lib/haptics';

interface CurrencyPickerProps {
  value: string;
  onChange: (code: string) => void;
}

/** Collapsed pill (flag + name + chevron); tap to expand the currency list. */
export function CurrencyPicker({ value, onChange }: CurrencyPickerProps) {
  const { palette } = useTheme();
  const styles = makeStyles(palette);
  const [open, setOpen] = useState(false);
  const selected = CURRENCY_LIST.find(c => c.code === value) ?? CURRENCY_LIST[0];

  return (
    <View style={{ gap: spacing[3] }}>
      <Pressable style={styles.trigger} onPress={() => { haptics.toggle(!open); setOpen(v => !v); }}>
        <Text style={styles.flag}>{selected.flag}</Text>
        <View style={{ flex: 1 }}>
          <Text variant="label" style={{ color: palette.primary }}>{selected.name}</Text>
          <Text variant="caption" color="secondary">{selected.sub}</Text>
        </View>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={18} color={palette.primary} />
      </Pressable>

      {open && (
        <View style={styles.list}>
          {CURRENCY_LIST.map((c, i) => {
            const isSelected = value === c.code;
            const isLast = i === CURRENCY_LIST.length - 1;
            return (
              <Pressable
                key={c.code}
                onPress={() => { haptics.select(); onChange(c.code); setOpen(false); }}
                style={[styles.row, isSelected && styles.rowSelected, !isLast && styles.rowBorder]}>
                <Text style={styles.flag}>{c.flag}</Text>
                <View style={{ flex: 1 }}>
                  <Text variant="label" style={isSelected ? { color: palette.primary } : undefined}>{c.name}</Text>
                  <Text variant="caption" color="secondary">{c.sub}</Text>
                </View>
                {isSelected && <Ionicons name="checkmark" size={18} color={palette.primary} />}
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    trigger: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[3],
      paddingHorizontal: spacing[4], paddingVertical: spacing[3],
      backgroundColor: p.primaryLight,
      borderRadius: radius.md,
      borderWidth: 1, borderColor: p.primary + '50',
    },
    list: { borderRadius: radius.md, borderWidth: 1, borderColor: p.border, overflow: 'hidden' },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing[3], paddingHorizontal: spacing[4], paddingVertical: spacing[3], backgroundColor: p.surface },
    rowSelected: { backgroundColor: p.primaryLight },
    rowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.border },
    flag: { fontSize: 22, width: 30, textAlign: 'center' as const },
  });
}
