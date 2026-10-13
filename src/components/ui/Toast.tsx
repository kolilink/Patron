import { useEffect, useMemo, useRef } from 'react';
import { Animated, PanResponder, Platform, Pressable, StyleSheet, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Text } from './Text';
import { useToastStore, type ToastItem } from '@/stores/toast';
import { useTheme, radius, spacing } from '@/src/theme';
import { useReduceMotion } from '@/src/hooks/useReduceMotion';

// THE toast. A compact floating pill, centered at the top, translucent (blur over a tint — never a slab), that
// takes only the room its words need. Swipe it up to dismiss; it also goes away by itself (see stores/toast.ts).
// An optional action ("Annuler") lives inside the pill. Several toasts stack; a new one never replaces another.
// Mounted once in (app)/_layout.tsx. No per-screen toasts, no full-width banners.

const SWIPE_DISMISS_DY = -24;
const ENTER_OFFSET = -90;

function ToastPill({ item }: { item: ToastItem }) {
  const { palette, resolvedScheme } = useTheme();
  const reduce = useReduceMotion();
  const { message: toastText } = item;
  const dismiss = useToastStore(s => s.dismiss);
  const runAction = useToastStore(s => s.runAction);
  const y = useRef(new Animated.Value(reduce ? 0 : ENTER_OFFSET)).current;
  const opacity = useRef(new Animated.Value(reduce ? 1 : 0)).current;

  useEffect(() => {
    if (reduce) return;
    Animated.parallel([
      Animated.spring(y, { toValue: 0, useNativeDriver: true, tension: 90, friction: 13 }),
      Animated.timing(opacity, { toValue: 1, duration: 140, useNativeDriver: true }),
    ]).start();
  }, [reduce, y, opacity]);

  const flyAway = () => {
    Animated.parallel([
      Animated.timing(y, { toValue: ENTER_OFFSET, duration: 160, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 0, duration: 160, useNativeDriver: true }),
    ]).start(() => dismiss(item.id));
  };

  const pan = useMemo(() => PanResponder.create({
    // Only an upward drag claims the gesture, so taps on "Annuler" still work.
    onMoveShouldSetPanResponder: (_e, g) => g.dy < -4 && Math.abs(g.dy) > Math.abs(g.dx),
    onPanResponderMove: (_e, g) => { if (g.dy < 0) y.setValue(g.dy); },
    onPanResponderRelease: (_e, g) => {
      if (g.dy <= SWIPE_DISMISS_DY || g.vy < -0.5) flyAway();
      else Animated.spring(y, { toValue: 0, useNativeDriver: true }).start();
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [item.id]);

  const accent = item.tone === 'warning' ? palette.warning : item.tone === 'info' ? palette.primary : palette.success;
  const icon = item.tone === 'warning' ? 'alert-circle' : item.tone === 'info' ? 'information-circle' : 'checkmark-circle';
  const blurOk = Platform.OS === 'ios' || Number(Platform.Version) >= 33;
  const action = item.action && !item.actionExpired ? item.action : null;
  const followUp = item.actionExpired ? item.followUp : null;

  return (
    <Animated.View
      {...pan.panHandlers}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={[styles.pill, { borderColor: palette.border, transform: [{ translateY: y }], opacity, backgroundColor: blurOk ? 'transparent' : palette.tabBarGlass }]}
    >
      {blurOk && (
        <BlurView
          intensity={48}
          tint={resolvedScheme === 'dark' ? 'dark' : 'light'}
          experimentalBlurMethod={Platform.OS === 'android' ? 'dimezisBlurView' : undefined}
          style={[StyleSheet.absoluteFill, { backgroundColor: palette.tabBarOverlay }]}
        />
      )}
      <View style={styles.content}>
        <Ionicons name={icon} size={18} color={accent} />
        <Text variant="bodySmall" numberOfLines={2} style={styles.label}>{toastText}</Text>
        {action && (
          <Pressable
            onPress={() => { void runAction(item.id); }}
            disabled={item.busy}
            hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
            style={styles.action}
            accessibilityRole="button"
            accessibilityLabel={action.label}
          >
            <Text variant="label" style={{ color: palette.primary }}>{item.busy ? '…' : action.label}</Text>
          </Pressable>
        )}
        {followUp && (
          <Pressable
            onPress={() => { followUp.run(); dismiss(item.id); }}
            hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
            style={styles.action}
            accessibilityRole="button"
            accessibilityLabel={followUp.label}
          >
            <Text variant="label" style={{ color: palette.primary }}>{followUp.label}</Text>
          </Pressable>
        )}
      </View>
    </Animated.View>
  );
}

export function ToastHost() {
  const toasts = useToastStore(s => s.toasts);
  const insets = useSafeAreaInsets();
  if (toasts.length === 0) return null;
  return (
    // The wrapper ignores touches so only the pills themselves are interactive.
    <View pointerEvents="box-none" style={[styles.host, { top: insets.top + spacing[2] }]}>
      {toasts.map(t => <ToastPill key={t.id} item={t} />)}
    </View>
  );
}

const styles = StyleSheet.create({
  host: { position: 'absolute', left: spacing[4], right: spacing[4], alignItems: 'center', gap: spacing[2], zIndex: 100 },
  pill: {
    maxWidth: '100%',
    minHeight: 44,
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  content: { flexDirection: 'row', alignItems: 'center', gap: spacing[2], paddingHorizontal: spacing[4], paddingVertical: spacing[2] },
  label: { flexShrink: 1, fontWeight: '600' as const },
  action: { minHeight: 44, justifyContent: 'center', paddingLeft: spacing[2] },
});
