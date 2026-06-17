import React, { useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Text } from './Text';
import { useTheme } from '@/src/theme';
import type { Palette } from '@/src/theme';

interface Props {
  length?: number;
  onComplete: (code: string) => void;
  disabled?: boolean;
}

export function OtpInput({ length = 6, onComplete, disabled = false }: Props) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const [value, setValue] = useState('');
  const inputRef = useRef<TextInput>(null);

  const digits = value.split('').concat(Array(length).fill('')).slice(0, length);

  function handleChange(text: string) {
    const cleaned = text.replace(/\D/g, '').slice(0, length);
    setValue(cleaned);
    if (cleaned.length === length) onComplete(cleaned);
  }

  return (
    <Pressable onPress={() => inputRef.current?.focus()} style={styles.container}>
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={handleChange}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        maxLength={length}
        editable={!disabled}
        caretHidden
        style={styles.hiddenInput}
      />
      <View style={styles.boxes}>
        {digits.map((digit, i) => {
          const isFocused = !disabled && i === value.length && value.length < length;
          const isFilled  = i < value.length;
          return (
            <View key={i} style={[styles.box, isFilled && styles.boxFilled, isFocused && styles.boxFocused]}>
              <Text variant="h2" style={[styles.digit, !isFilled && styles.digitEmpty]}>{digit}</Text>
              {isFocused && <View style={styles.cursor} />}
            </View>
          );
        })}
      </View>
    </Pressable>
  );
}

const BOX = 48;

function makeStyles(p: Palette) {
  return StyleSheet.create({
    container:   { alignItems: 'center' },
    hiddenInput: { position: 'absolute', width: 1, height: 1, opacity: 0 },
    boxes:       { flexDirection: 'row', gap: 10 },
    box: {
      width: BOX, height: BOX + 8, borderRadius: 12,
      borderWidth: 1.5, borderColor: p.border,
      backgroundColor: p.surface,
      alignItems: 'center', justifyContent: 'center',
    },
    boxFilled:  { borderColor: p.primary, backgroundColor: p.primaryLight },
    boxFocused: { borderColor: p.primary, borderWidth: 2 },
    digit:      { textAlign: 'center', letterSpacing: 0 },
    digitEmpty: { opacity: 0 },
    cursor: {
      position: 'absolute', bottom: 10,
      width: 18, height: 2, borderRadius: 1,
      backgroundColor: p.primary,
    },
  });
}
