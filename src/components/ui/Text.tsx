import React from 'react';
import { Text as RNText, TextProps as RNTextProps, StyleSheet } from 'react-native';
import { palette, typography } from '../../theme';

type Variant = keyof typeof typography;
type Color = 'primary' | 'secondary' | 'disabled' | 'inverse' | 'success' | 'warning' | 'danger' | 'brand';

interface TextProps extends RNTextProps {
  variant?: Variant;
  color?: Color;
}

const colorMap: Record<Color, string> = {
  primary: palette.textPrimary,
  secondary: palette.textSecondary,
  disabled: palette.textDisabled,
  inverse: palette.textInverse,
  success: palette.success,
  warning: palette.warning,
  danger: palette.danger,
  brand: palette.primary,
};

export function Text({ variant = 'body', color = 'primary', style, ...props }: TextProps) {
  return (
    <RNText
      style={[typography[variant], { color: colorMap[color] }, style]}
      {...props}
    />
  );
}
