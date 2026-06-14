import React, { useMemo } from 'react';
import {
  ActivityIndicator,
  Pressable,
  PressableProps,
  PressableStateCallbackType,
  StyleProp,
  StyleSheet,
  View,
  ViewStyle,
} from 'react-native';
import { useTheme } from '../../theme';
import { radius, spacing, typography } from '../../theme';
import type { Palette } from '../../theme';
import { Text } from './Text';

type Variant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends Omit<PressableProps, 'style'> {
  variant?: Variant;
  size?: Size;
  label: string;
  loading?: boolean;
  icon?: React.ReactNode;
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function Button({
  variant = 'primary',
  size = 'md',
  label,
  loading = false,
  icon,
  fullWidth = false,
  disabled,
  style,
  ...props
}: ButtonProps) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);

  const isDisabled = disabled || loading;
  const sizeStyle = size === 'sm' ? styles.size_sm : size === 'lg' ? styles.size_lg : styles.size_md;

  const getStyle = ({ pressed }: PressableStateCallbackType): StyleProp<ViewStyle> => [
    styles.base,
    styles[variant],
    sizeStyle,
    fullWidth ? styles.fullWidth : null,
    pressed ? styles.pressed : null,
    isDisabled ? styles.disabled : null,
    style,
  ];

  const textColor = variant === 'outline' || variant === 'ghost'
    ? palette.primary
    : variant === 'secondary'
      ? palette.textPrimary
      : palette.textInverse;

  return (
    <Pressable disabled={isDisabled} style={getStyle} {...props}>
      {loading ? (
        <ActivityIndicator
          size="small"
          color={variant === 'outline' || variant === 'ghost' ? palette.primary : palette.textInverse}
        />
      ) : (
        <View style={styles.content}>
          {icon && <View style={styles.icon}>{icon}</View>}
          <Text
            style={[
              typography.labelLarge,
              { color: textColor },
              variant === 'danger' && { color: palette.textInverse },
            ]}
          >
            {label}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    base: {
      borderRadius: radius.md,
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'row',
    },
    content: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing[2],
    },
    icon: { marginRight: 2 },
    fullWidth: { width: '100%' },
    pressed:   { opacity: 0.82 },
    disabled:  { opacity: 0.45 },

    primary:   { backgroundColor: p.primary },
    secondary: { backgroundColor: p.border },
    outline:   { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: p.primary },
    ghost:     { backgroundColor: 'transparent' },
    danger:    { backgroundColor: p.danger },

    size_sm: { paddingHorizontal: spacing[3],  paddingVertical: spacing[2],   minHeight: 44 },
    size_md: { paddingHorizontal: spacing[5],  paddingVertical: spacing[3],   minHeight: 48 },
    size_lg: { paddingHorizontal: spacing[6],  paddingVertical: spacing[4],   minHeight: 56 },
  });
}
