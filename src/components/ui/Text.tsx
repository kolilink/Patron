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

export function Text({
  variant = 'body',
  color = 'primary',
  style,
  allowFontScaling = true,
  // Respects the OS text-size setting (accessibility) without letting the most
  // extreme settings (iOS goes up to ~3.5x) break layouts nobody designed for
  // that much growth. Fixed-geometry text (single-glyph avatar initials, the
  // OTP digit boxes) overrides this back to allowFontScaling={false} at the
  // call site instead — see src/components/ui/OtpInput.tsx for the pattern.
  maxFontSizeMultiplier = 1.3,
  ...props
}: TextProps) {
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
      allowFontScaling={allowFontScaling}
      maxFontSizeMultiplier={maxFontSizeMultiplier}
      style={[typography[variant], { color: colorMap[color] }, style]}
      {...props}
    />
  );
}
