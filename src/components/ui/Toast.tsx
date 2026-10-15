import { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, LayoutAnimation, PanResponder, Platform, Pressable, StyleSheet, UIManager, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Text } from './Text';
import { useToastStore, TOAST_EXIT_MS, type ToastItem } from '@/stores/toast';
import { useTheme, radius, spacing } from '@/src/theme';
import { useReduceMotion } from '@/src/hooks/useReduceMotion';

// THE toast. A compact floating pill, centered at the top, translucent (blur over a tint — never a slab), that
// takes only the room its words need. Swipe it up to dismiss; it also goes away by itself (see stores/toast.ts).
// An optional action ("Annuler") lives inside the pill. Distinct toasts stack; a repeat of the same plain
// toast coalesces into the pill already up (see stores/toast.ts).
// Mounted once in (app)/_layout.tsx. No per-screen toasts, no full-width banners.
//
// Motion (modeled on the Muse.ai "Copied to clipboard" pill): in = fade + an 8px settle over 200ms, no
// spring and no long drop; out = the mirror image over TOAST_EXIT_MS, driven by the store's `exiting` flag
// so a timeout leaves exactly like a swipe; when a pill joins or leaves, the others glide to their new slot
// (LayoutAnimation) instead of jumping.

const SWIPE_DISMISS_DY = -24;
const ENTER_OFFSET = -8;
const ENTER_MS = 200;
const STACK_GLIDE_MS = 200;

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

function ToastPill({ item }: { item: ToastItem }) {
  const { palette, resolvedScheme } = useTheme();
  const reduce = useReduceMotion();
  const { message: toastText } = item;
  const dismiss = useToastStore(s => s.dismiss);
  const remove = useToastStore(s => s.remove);
  const runAction = useToastStore(s => s.runAction);
  const y = useRef(new Animated.Value(reduce ? 0 : ENTER_OFFSET)).current;
  const opacity = useRef(new Animated.Value(reduce ? 1 : 0)).current;
  const exiting = item.exiting;

  useEffect(() => {
    if (reduce) { y.setValue(0); opacity.setValue(1); return; }
    Animated.parallel([
      Animated.timing(y, { toValue: 0, duration: ENTER_MS, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, duration: ENTER_MS, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start();
  }, [reduce, y, opacity]);

  // The store flags `exiting` (timeout, swipe, action done): animate out over the same window the store
  // counts before removing the pill, so the list never pops. Reduced motion skips straight to removal.
  useEffect(() => {
    if (!exiting) return;
    if (reduce) { remove(item.id); return; }
    Animated.parallel([
      Animated.timing(y, { toValue: ENTER_OFFSET, duration: TOAST_EXIT_MS, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 0, duration: TOAST_EXIT_MS, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
    ]).start();
  }, [exiting, reduce, y, opacity, remove, item.id]);

  const pan = useMemo(() => PanResponder.create({
    // Only an upward drag claims the gesture, so taps on "Annuler" still work.
    onMoveShouldSetPanResponder: (_e, g) => g.dy < -4 && Math.abs(g.dy) > Math.abs(g.dx),
    onPanResponderMove: (_e, g) => { if (g.dy < 0) y.setValue(g.dy); },
    onPanResponderRelease: (_e, g) => {
      if (g.dy <= SWIPE_DISMISS_DY || g.vy < -0.5) dismiss(item.id);
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
  const reduce = useReduceMotion();
  const ids = toasts.map(t => t.id).join(',');
  const firstRender = useRef(true);

  // When the stack changes (a pill joins, or one finishes exiting and is removed), glide the remaining
  // pills to their new positions instead of letting them jump. Skipped on first mount and for reduced motion.
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    if (reduce) return;
    LayoutAnimation.configureNext(LayoutAnimation.create(STACK_GLIDE_MS, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity));
  }, [ids, reduce]);

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

