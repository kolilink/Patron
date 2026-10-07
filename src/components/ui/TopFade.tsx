import { StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { interpolate, useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { useTheme } from '@/src/theme';

export const TOP_FADE_HEIGHT = 28;
const FADE_IN_DISTANCE = 48;

/**
 * Scroll-driven fade pinned under a sticky header: invisible at rest
 * (scrollY = 0), eases in over the first 48px so content visibly dissolves
 * because the user moved it. Driven by a shared value — no re-renders, no
 * blur (real-time blur is the jank source on low-end Android). Render as a
 * sibling after the list, inside a relatively-positioned parent containing
 * only the list.
 */
export function TopFade({ scrollY }: { scrollY: SharedValue<number> }) {
  const { palette } = useTheme();
  const style = useAnimatedStyle(() => ({
    opacity: interpolate(scrollY.value, [0, FADE_IN_DISTANCE], [0, 1], 'clamp'),
  }));
  return (
    <Animated.View pointerEvents="none" style={[styles.fade, style]}>
      <LinearGradient colors={[palette.background, 'transparent']} style={StyleSheet.absoluteFill} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  fade: { position: 'absolute', top: 0, left: 0, right: 0, height: TOP_FADE_HEIGHT },
});
