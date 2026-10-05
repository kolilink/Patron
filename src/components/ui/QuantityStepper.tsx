import React, { useMemo } from 'react';
import { Platform, Pressable, StyleProp, StyleSheet, TextInput, TextStyle, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/src/theme';
import { spacing } from '@/src/theme';
import { stepQuantity, stepIsBlocked, type StepBounds } from '@/src/utils/quantity';
import { haptics } from '@/lib/haptics';

interface Props extends StepBounds {
  /** Typed text of the quantity (kept as a string so a half-typed value is never fought). */
  value: string;
  onChange: (next: string) => void;
  /** Style for the centre input (so it matches the screen's own field look). */
  inputStyle?: StyleProp<TextStyle>;
  inputRef?: React.Ref<TextInput>;
  inputAccessoryViewID?: string;
  placeholder?: string;
  onFocus?: () => void;
  onSubmitEditing?: () => void;
  returnKeyType?: 'done' | 'next';
  /** 36px buttons for tight rows. */
  compact?: boolean;
}

/**
 * − [ 12 ] + around a quantity the user can also type. Each tap changes the
 * value on the same frame (state update, pressed-state feedback), stops at
 * min (default 1) / max, and a blocked direction is visibly dimmed.
 */
export function QuantityStepper({
  value, onChange, min, max, inputStyle, inputRef, inputAccessoryViewID, placeholder, onFocus, onSubmitEditing, returnKeyType, compact,
}: Props) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette.surface, palette.border, compact ? 36 : 44), [palette, compact]);
  const bounds = { min, max };
  const tap = (delta: 1 | -1) => {
    if (stepIsBlocked(value, delta, bounds)) return;
    haptics.throttledSelect();
    onChange(String(stepQuantity(value, delta, bounds)));
  };
  const decBlocked = stepIsBlocked(value, -1, bounds);
  const incBlocked = stepIsBlocked(value, 1, bounds);
  return (
    <View style={styles.row}>
      <Pressable
        onPress={() => tap(-1)}
        hitSlop={8}
        style={({ pressed }) => [styles.btn, (decBlocked || pressed) && styles.dim]}
        accessibilityRole="button"
        accessibilityLabel="Diminuer la quantité"
        accessibilityState={{ disabled: decBlocked }}
      >
        <Ionicons name="remove" size={20} color={palette.textPrimary} />
      </Pressable>
      <TextInput
        ref={inputRef}
        style={[styles.input, { color: palette.textPrimary }, inputStyle]}
        value={value}
        onChangeText={t => onChange(t.replace(/[^0-9]/g, ''))}
        keyboardType="number-pad"
        placeholder={placeholder}
        placeholderTextColor={palette.textDisabled}
        onFocus={onFocus}
        onSubmitEditing={onSubmitEditing}
        returnKeyType={returnKeyType}
        inputAccessoryViewID={Platform.OS === 'ios' ? inputAccessoryViewID : undefined}
        selectTextOnFocus
      />
      <Pressable
        onPress={() => tap(1)}
        hitSlop={8}
        style={({ pressed }) => [styles.btn, (incBlocked || pressed) && styles.dim]}
        accessibilityRole="button"
        accessibilityLabel="Augmenter la quantité"
        accessibilityState={{ disabled: incBlocked }}
      >
        <Ionicons name="add" size={20} color={palette.textPrimary} />
      </Pressable>
    </View>
  );
}

function makeStyles(surface: string, border: string, size: number) {
  return StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
    btn: {
      width: size, height: size, borderRadius: size / 2, backgroundColor: surface,
      borderWidth: 1, borderColor: border, alignItems: 'center', justifyContent: 'center',
    },
    dim: { opacity: 0.4 },
    input: { flex: 1, textAlign: 'center', minHeight: 44, fontSize: 16 },
  });
}
