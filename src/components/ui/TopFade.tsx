import { StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme } from '@/src/theme';

export const TOP_FADE_HEIGHT = 30;

/**
 * Static fade strip pinned at the top of a scroll container, just under a
 * sticky header: content dissolves into the background instead of clipping.
 * No scroll listeners and no blur (real-time blur over scrolling content is
 * the jank source on low-end Android). Render as a SIBLING AFTER the list, inside
 * a relatively-positioned parent that only contains the list.
 */
/** `color` defaults to the page background; pass palette.surface over a surface-coloured container. */
export function TopFade({ color }: { color?: string }) {
  const { palette } = useTheme();
  return (
    <LinearGradient
      pointerEvents="none"
      colors={[color ?? palette.background, 'transparent']}
      style={styles.fade}
    />
  );
}

const styles = StyleSheet.create({
  fade: { position: 'absolute', top: 0, left: 0, right: 0, height: TOP_FADE_HEIGHT },
});
