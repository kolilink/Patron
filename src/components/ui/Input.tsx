import React, { forwardRef, useState } from 'react';
import { StyleSheet, TextInput, TextInputProps, View } from 'react-native';
import { palette, radius, spacing, typography } from '../../theme';
import { Text } from './Text';

interface InputProps extends TextInputProps {
  label?: string;
  error?: string;
  hint?: string;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

export const Input = forwardRef<TextInput, InputProps>(function Input({
  label,
  error,
  hint,
  leftIcon,
  rightIcon,
  style,
  ...props
}: InputProps, ref: React.ForwardedRef<TextInput>) {
  const [focused, setFocused] = useState(false);

  return (
    <View style={styles.wrapper}>
      {label && (
        <Text variant="label" style={styles.label}>
          {label}
        </Text>
      )}
      <View
        style={[
          styles.container,
          focused && styles.containerFocused,
          !!error && styles.containerError,
        ]}
      >
        {leftIcon && <View style={styles.leftIcon}>{leftIcon}</View>}
        <TextInput
          ref={ref}
          style={[styles.input, leftIcon && styles.inputWithLeft, rightIcon && styles.inputWithRight, style]}
          placeholderTextColor={palette.textDisabled}
          onFocus={(e) => { setFocused(true); props.onFocus?.(e); }}
          onBlur={(e) => { setFocused(false); props.onBlur?.(e); }}
          {...props}
        />
        {rightIcon && <View style={styles.rightIcon}>{rightIcon}</View>}
      </View>
      {(error || hint) && (
        <Text variant="caption" color={error ? 'danger' : 'secondary'} style={styles.hint}>
          {error ?? hint}
        </Text>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  wrapper: {
    gap: spacing[1.5],
  },
  label: {
    color: palette.textPrimary,
  },
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: palette.border,
    borderRadius: radius.md,
    backgroundColor: palette.surface,
    minHeight: 48,
  },
  containerFocused: {
    borderColor: palette.primary,
    backgroundColor: palette.surface,
  },
  containerError: {
    borderColor: palette.danger,
  },
  input: {
    flex: 1,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2.5],
    ...typography.body,
    color: palette.textPrimary,
  },
  inputWithLeft: {
    paddingLeft: spacing[1],
  },
  inputWithRight: {
    paddingRight: spacing[1],
  },
  leftIcon: {
    paddingLeft: spacing[3],
  },
  rightIcon: {
    paddingRight: spacing[3],
  },
  hint: {
    marginTop: 2,
  },
});
