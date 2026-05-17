import React from 'react';
import { Pressable, StyleSheet, View, ViewProps } from 'react-native';
import { palette, radius, shadow, spacing } from '../../theme';

interface CardProps extends ViewProps {
  onPress?: () => void;
  padded?: boolean;
  elevated?: boolean;
}

export function Card({ onPress, padded = true, elevated = false, style, children, ...props }: CardProps) {
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

const styles = StyleSheet.create({
  card: {
    backgroundColor: palette.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: palette.border,
  },
  padded: {
    padding: spacing[4],
  },
  pressed: {
    opacity: 0.88,
  },
});
