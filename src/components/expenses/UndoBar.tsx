import { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing, radius } from '@/src/theme';

export const EXPENSE_UNDO_MS = 10_000;

export interface UndoBarState { id: number; text: string; onUndo: () => void | Promise<void> }

// Bottom bar, 10 seconds, one action. Nothing about it blocks the screen.
export function UndoBar({ state, onExpire }: { state: UndoBarState | null; onExpire: (id: number) => void }) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const slide = useRef(new Animated.Value(80)).current;

  useEffect(() => {
    if (!state) return;
    slide.setValue(80);
    Animated.timing(slide, { toValue: 0, duration: 180, useNativeDriver: true }).start();
    const t = setTimeout(() => onExpire(state.id), EXPENSE_UNDO_MS);
    return () => clearTimeout(t);
  }, [state?.id]);

  if (!state) return null;
  return (
    <Animated.View
      style={[
        styles.bar,
        { bottom: insets.bottom + spacing[4], backgroundColor: palette.textPrimary, transform: [{ translateY: slide }] },
      ]}
    >
      <Text variant="bodySmall" numberOfLines={2} style={{ flex: 1, color: palette.textInverse }}>{state.text}</Text>
      <Pressable onPress={() => { onExpire(state.id); void state.onUndo(); }} hitSlop={12} accessibilityRole="button">
        <Text variant="label" style={{ color: palette.textInverse, textDecorationLine: 'underline' }}>Annuler</Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute', left: spacing[4], right: spacing[4], zIndex: 20,
    flexDirection: 'row', alignItems: 'center', gap: spacing[4],
    paddingHorizontal: spacing[4], paddingVertical: spacing[3], borderRadius: radius.lg,
  },
});
