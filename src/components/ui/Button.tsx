import React, { useMemo, useRef } from 'react';
import {
  ActivityIndicator,
  Animated,
  Pressable,
  PressableProps,
  PressableStateCallbackType,
  StyleProp,
  StyleSheet,
  TextStyle,
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
  /** Overrides the label's own text style (e.g. a larger fontSize for a
   *  screen's single most important action) without touching every other
   *  Button in the app — the button box itself sizes off `size`/padding,
   *  not off this, so a bigger label just uses more of the existing
   *  minHeight budget rather than growing the button to match. */
  labelStyle?: StyleProp<TextStyle>;
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
  labelStyle,
  onPressIn,
  onPressOut,
  ...props
}: ButtonProps) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const scale = useRef(new Animated.Value(1)).current;

  const handlePressIn = (event: Parameters<NonNullable<PressableProps['onPressIn']>>[0]) => {
    Animated.timing(scale, { toValue: 0.97, duration: 90, useNativeDriver: true }).start();
    onPressIn?.(event);
  };
  const handlePressOut = (event: Parameters<NonNullable<PressableProps['onPressOut']>>[0]) => {
    Animated.timing(scale, { toValue: 1, duration: 110, useNativeDriver: true }).start();
    onPressOut?.(event);
  };

  const isDisabled = disabled || loading;
  const sizeStyle = size === 'sm' ? styles.size_sm : size === 'lg' ? styles.size_lg : styles.size_md;

  const getStyle = ({ pressed }: PressableStateCallbackType): StyleProp<ViewStyle> => [
    styles.base,
    styles[variant],
    sizeStyle,
    fullWidth ? styles.fullWidth : null,
    { transform: [{ scale }] },
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
    <Pressable
      disabled={isDisabled}
      style={getStyle}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      {...props}
    >
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
              labelStyle,
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
    pressed: { opacity: 0.82 },
    disabled: { opacity: 0.45 },

    primary: { backgroundColor: p.primary },
    secondary: { backgroundColor: p.border },
    outline: { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: p.primary },
    ghost: { backgroundColor: 'transparent' },
    danger: { backgroundColor: p.danger },

    size_sm: { paddingHorizontal: spacing[3], paddingVertical: spacing[2], minHeight: 44 },
    size_md: { paddingHorizontal: spacing[5], paddingVertical: spacing[3], minHeight: 48 },
    size_lg: { paddingHorizontal: spacing[6], paddingVertical: spacing[4], minHeight: 56 },
  });
}
