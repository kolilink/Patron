import React, { useMemo } from 'react';
import {
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
import { LoadingStatus } from './LoadingStatus';
import { resolveLoadingWord } from './loadingLanguage';

type Variant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends Omit<PressableProps, 'style'> {
  variant?: Variant;
  size?: Size;
  label: string;
  loading?: boolean;
  /** Present-participle status word shown while `loading` ("Envoi", "Suppression"…). The dots are added automatically; a loading button never shows a lone spinner and keeps its words. */
  loadingLabel?: string;
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
  loadingLabel,
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
  const isDisabled = disabled || loading;
  const sizeStyle = size === 'sm' ? styles.size_sm : size === 'lg' ? styles.size_lg : styles.size_md;

  const getStyle = ({ pressed }: PressableStateCallbackType): StyleProp<ViewStyle> => [
    styles.base,
    styles[variant],
    sizeStyle,
    fullWidth ? styles.fullWidth : null,
    // NO `transform: [{ scale }]` here. This used to carry an Animated.Value on a
    // plain Pressable (not an Animated component). React Native only guards that
    // with a __DEV__ invariant ("You passed an Animated.Value to a normal
    // component"); in a release build the Animated.Value object reaches native as
    // a map, and Android's TransformHelper then dies on
    // ReadableNativeMap.getDouble("scale") — a fatal crash ~3s after launch on
    // every Android 1.0.9 (101) install (Sentry REACT-NATIVE-B). Press feedback is
    // the `pressed` style below; do not reintroduce an animated transform on a
    // non-Animated component.
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
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      {...props}
    >
      {loading ? (
        <LoadingStatus
          word={resolveLoadingWord(loadingLabel)}
          color={textColor}
          textStyle={[typography.labelLarge, labelStyle]}
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
