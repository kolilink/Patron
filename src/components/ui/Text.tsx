import React from 'react';
import { Text as RNText, TextProps as RNTextProps } from 'react-native';
import { useTheme } from '../../theme';
import { typography } from '../../theme';

type Variant = keyof typeof typography;
type Color = 'primary' | 'secondary' | 'disabled' | 'inverse' | 'success' | 'warning' | 'danger' | 'brand';

interface TextProps extends RNTextProps {
  variant?: Variant;
  color?: Color;
}

export function Text({ variant = 'body', color = 'primary', style, ...props }: TextProps) {
  const { palette } = useTheme();
  const colorMap: Record<Color, string> = {
    primary:   palette.textPrimary,
    secondary: palette.textSecondary,
    disabled:  palette.textDisabled,
    inverse:   palette.textInverse,
    success:   palette.success,
    warning:   palette.warning,
    danger:    palette.danger,
    brand:     palette.primary,
  };
  return (
    <RNText
      allowFontScaling={false}
      style={[typography[variant], { color: colorMap[color] }, style]}
      {...props}
    />
  );
}
