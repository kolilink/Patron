import React, { useMemo, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useTheme } from '@/src/theme';
import type { Palette } from '@/src/theme';

interface Props {
  length?: number;
  onComplete: (code: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Bumped by the parent to force-clear the field after a wrong PIN. */
  resetSignal?: number;
}

export function PinInput({ length = 4, onComplete, disabled = false, autoFocus = false, resetSignal }: Props) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const [value, setValue] = useState('');
  const inputRef = useRef<TextInput>(null);

  React.useEffect(() => {
    setValue('');
  }, [resetSignal]);

  const digits = value.split('').concat(Array(length).fill('')).slice(0, length);

  function handleChange(text: string) {
    const cleaned = text.replace(/\D/g, '').slice(0, length);
    setValue(cleaned);
    if (cleaned.length === length) onComplete(cleaned);
  }

  // Same OPPO/Xiaomi keyboard workaround as OtpInput — blur then re-focus.
  function handlePress() {
    if (disabled) return;
    if (Platform.OS === 'android') {
      inputRef.current?.blur();
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      inputRef.current?.focus();
    }
  }

  return (
    <Pressable onPress={handlePress} style={styles.container}>
      <View style={styles.boxes}>
        {digits.map((digit, i) => {
          const isFocused = !disabled && i === value.length && value.length < length;
          const isFilled  = i < value.length;
          return (
            <View key={i} style={[styles.box, isFilled && styles.boxFilled, isFocused && styles.boxFocused]}>
              {isFilled && <View style={styles.dot} />}
              {isFocused && <View style={styles.cursor} />}
            </View>
          );
        })}
      </View>
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={handleChange}
        keyboardType="number-pad"
        secureTextEntry
        maxLength={length}
        editable={!disabled}
        caretHidden
        autoFocus={autoFocus}
        style={styles.hiddenInput}
      />
    </Pressable>
  );
}

const BOX = 48;

function makeStyles(p: Palette) {
  return StyleSheet.create({
    container:   { alignItems: 'center' },
    hiddenInput: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: 0 },
    boxes:       { flexDirection: 'row', gap: 10 },
    box: {
      width: BOX, height: BOX + 8, borderRadius: 12,
      borderWidth: 1.5, borderColor: p.border,
      backgroundColor: p.surface,
      alignItems: 'center', justifyContent: 'center',
    },
    boxFilled:  { borderColor: p.primary, backgroundColor: p.primaryLight },
    boxFocused: { borderColor: p.primary, borderWidth: 2 },
    dot: {
      width: 12, height: 12, borderRadius: 6,
      backgroundColor: p.primary,
    },
    cursor: {
      position: 'absolute', bottom: 10,
      width: 18, height: 2, borderRadius: 1,
      backgroundColor: p.primary,
    },
  });
}
