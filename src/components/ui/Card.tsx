import React, { useMemo } from 'react';
import { Pressable, StyleSheet, View, ViewProps } from 'react-native';
import { useTheme } from '../../theme';
import { radius, shadow, spacing } from '../../theme';
import type { Palette } from '../../theme';

interface CardProps extends ViewProps {
  onPress?: () => void;
  padded?: boolean;
  elevated?: boolean;
}

export function Card({ onPress, padded = true, elevated = false, style, children, ...props }: CardProps) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);

  const inner = (
    <View
      style={[
        styles.card,
        padded && styles.padded,
        elevated && shadow.md,
        style,
      ]}
      {...props}
    >
      {children}
    </View>
  );

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [pressed && styles.pressed]}
      >
        {inner}
      </Pressable>
    );
  }

  return inner;
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    card: {
      backgroundColor: p.surface,
      borderRadius: radius.card,
      borderWidth: 1,
      borderColor: p.border,
    },
    padded: {
      padding: spacing[5],
    },
    pressed: {
      opacity: 0.88,
    },
  });
}
