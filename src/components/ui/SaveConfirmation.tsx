import { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Text } from './Text';
import { useSaveConfirmationStore, UNDO_WINDOW_MS } from '@/stores/saveConfirmation';
import { useTheme, radius, spacing } from '@/src/theme';

// Sits alongside <AppToastContainer /> (mounted once in (app)/_layout.tsx).
// Unlike a plain toast, this banner can carry an "Annuler" undo action for
// ~8s, then — if the record still needs a correction — hands off to that
// record's existing edit screen instead of just disappearing. See
// stores/saveConfirmation.ts for why this is a separate mechanism from toast.

export function SaveConfirmation() {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const { visible, message, tone, expired, undo, onEdit, undoing, hide, expire, runUndo } =
    useSaveConfirmationStore();

  const slideY = useRef(new Animated.Value(-160)).current;
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    if (dismissTimer.current) clearTimeout(dismissTimer.current);

    if (visible) {
      Animated.spring(slideY, { toValue: 0, useNativeDriver: true, tension: 80, friction: 12 }).start();

      if (undo) {
        undoTimer.current = setTimeout(() => {
          expire();
          // Give the "Modifier" hand-off a few seconds of visibility, then
          // auto-dismiss like a toast would.
          dismissTimer.current = setTimeout(() => close(), 4000);
        }, UNDO_WINDOW_MS);
      } else {
        dismissTimer.current = setTimeout(() => close(), UNDO_WINDOW_MS);
      }
    } else {
      Animated.timing(slideY, { toValue: -160, duration: 250, useNativeDriver: true }).start();
    }

    return () => {
      if (undoTimer.current) clearTimeout(undoTimer.current);
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, message]);

  function close() {
    Animated.timing(slideY, { toValue: -160, duration: 250, useNativeDriver: true }).start(() => hide());
  }

  if (!visible) return null;

  const isSettled = tone === 'settled';
  const bg = isSettled ? palette.successLight : palette.surface;
  const accent = isSettled ? palette.success : palette.primary;

  return (
    <Animated.View
      style={[
        styles.container,
        { top: insets.top + spacing[3], backgroundColor: bg, borderColor: accent, shadowColor: palette.shadow, transform: [{ translateY: slideY }] },
      ]}
    >
      <View style={styles.row}>
        <Ionicons name="checkmark-circle" size={20} color={accent} />
        <Text variant="bodySmall" style={{ flex: 1, color: palette.textPrimary, fontWeight: '600' }} numberOfLines={2}>
          {message}
        </Text>
      </View>
      <View style={styles.actions}>
        {!expired && undo && (
          <Pressable onPress={runUndo} disabled={undoing} hitSlop={8}>
            <Text variant="label" style={{ color: palette.warning }}>
              {undoing ? '…' : 'Annuler'}
            </Text>
          </Pressable>
        )}
        {expired && onEdit && (
          <Pressable
            onPress={() => {
              onEdit();
              close();
            }}
            hitSlop={8}
          >
            <Text variant="label" style={{ color: palette.primary }}>Modifier</Text>
          </Pressable>
        )}
        <Pressable onPress={close} hitSlop={8}>
          <Ionicons name="close" size={18} color={palette.textSecondary} />
        </Pressable>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: spacing[4],
    right: spacing[4],
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    borderRadius: radius.lg,
    borderWidth: 1,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 8,
    elevation: 6,
    zIndex: 50,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing[2], flex: 1 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
});
