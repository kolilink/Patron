import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Text } from './Text';
import { useTheme } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { addSmsReceivedListener, startSmsRetriever, stopSmsRetriever } from '@/modules/sms-retriever';

interface Props {
  length?: number;
  onComplete: (code: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  // Android only — starts the SMS Retriever broadcast listener that WhatsApp's one-tap/zero-tap
  // authentication template autofill delivers the code through. Only pass this for OTP screens
  // where the code is actually sent via WhatsApp (not email/local-PIN screens).
  whatsappAutofill?: boolean;
}

export function OtpInput({ length = 6, onComplete, disabled = false, autoFocus = false, whatsappAutofill = false }: Props) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const [value, setValue] = useState('');
  const inputRef = useRef<TextInput>(null);

  const digits = value.split('').concat(Array(length).fill('')).slice(0, length);

  function handleChange(text: string) {
    // Strip non-digits and cap at length — handles both typing and full-string paste
    const cleaned = text.replace(/\D/g, '').slice(0, length);
    setValue(cleaned);
    if (cleaned.length === length) onComplete(cleaned);
  }

  useEffect(() => {
    if (!whatsappAutofill || Platform.OS !== 'android' || disabled) return;

    startSmsRetriever();
    const sub = addSmsReceivedListener(({ message }) => {
      const match = message.match(new RegExp(`\\d{${length}}`));
      if (match) handleChange(match[0]);
    });

    return () => {
      sub?.remove();
      stopSmsRetriever();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whatsappAutofill, disabled, length]);

  // On some Android OEM keyboards (OPPO, Xiaomi) calling focus() on an already-focused
  // input doesn't re-show the keyboard. Blur first then re-focus reliably re-opens it.
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
              <Text variant="h2" style={[styles.digit, !isFilled && styles.digitEmpty]}>{digit}</Text>
              {isFocused && <View style={styles.cursor} />}
            </View>
          );
        })}
      </View>
      {/* Rendered last so it's front-most in z-order — needed for long-press "Paste" to reach the
          native field instead of being intercepted by the boxes above it. */}
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
    // Cover the full Pressable area — a 1×1 input is ignored by OPPO/Xiaomi keyboards
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
    digit:      { textAlign: 'center', letterSpacing: 0 },
    digitEmpty: { opacity: 0 },
    cursor: {
      position: 'absolute', bottom: 10,
      width: 18, height: 2, borderRadius: 1,
      backgroundColor: p.primary,
    },
  });
}
