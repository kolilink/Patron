import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import DateTimePickerModal from 'react-native-modal-datetime-picker';
import { Text } from './Text';
import { palette, spacing, radius } from '@/src/theme';

const MONTHS_FR = [
  'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre',
];

function isoToDate(iso: string): Date {
  if (!iso) return new Date();
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function dateToIso(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatDisplay(iso: string): string {
  if (!iso) return 'Sélectionner';
  const d = isoToDate(iso);
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS_FR[d.getMonth()]} ${d.getFullYear()}`;
}

interface DatePickerFieldProps {
  label?: string;
  value: string;
  onChange: (isoDate: string) => void;
  maxToday?: boolean;
  minDate?: string;
}

export function DatePickerField({ label, value, onChange, maxToday = false, minDate }: DatePickerFieldProps) {
  const [open, setOpen] = useState(false);

  const maxDate = maxToday
    ? (() => { const d = new Date(); d.setHours(23, 59, 59, 999); return d; })()
    : undefined;
  const minDateObj = minDate ? isoToDate(minDate) : undefined;

  return (
    <View>
      {label ? <Text variant="label" style={styles.label}>{label}</Text> : null}
      <Pressable onPress={() => setOpen(true)} style={styles.field}>
        <Text variant="body">{formatDisplay(value)}</Text>
        <Text variant="caption" color="secondary">›</Text>
      </Pressable>

      <DateTimePickerModal
        isVisible={open}
        mode="date"
        date={isoToDate(value)}
        maximumDate={maxDate}
        minimumDate={minDateObj}
        locale="fr_FR"
        onConfirm={(date) => {
          setOpen(false);
          onChange(dateToIso(date));
        }}
        onCancel={() => setOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  label: { marginBottom: spacing[1] },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.surface,
  },
});
