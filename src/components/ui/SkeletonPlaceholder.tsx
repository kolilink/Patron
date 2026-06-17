import { useEffect, useMemo } from 'react';
import { StyleProp, StyleSheet, useWindowDimensions, View, ViewStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { useTheme } from '@/src/theme';
import { spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';

const SHIMMER_W = 150;
const SHIMMER_DURATION = 1000;

function useShimmerProgress(): SharedValue<number> {
  const { width } = useWindowDimensions();
  const progress = useSharedValue(-SHIMMER_W);
  useEffect(() => {
    progress.value = withRepeat(
      withTiming(width + SHIMMER_W, { duration: SHIMMER_DURATION, easing: Easing.linear }),
      -1,
      false,
    );
    return () => { cancelAnimation(progress); };
  }, [width]);
  return progress;
}

function ShimmerBar({ style, progress, scheme }: { style: StyleProp<ViewStyle>; progress: SharedValue<number>; scheme: 'light' | 'dark' }) {
  const anim = useAnimatedStyle(() => ({
    transform: [{ translateX: progress.value }],
  }));
  const shimmerColor = scheme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.62)';
  return (
    <View style={[style, { overflow: 'hidden' }]}>
      <Animated.View
        style={[StyleSheet.absoluteFill, { width: SHIMMER_W, backgroundColor: shimmerColor }, anim]}
      />
    </View>
  );
}

export function SkeletonList({ count = 6 }: { count?: number }) {
  const { palette, resolvedScheme } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const progress = useShimmerProgress();
  return (
    <View style={styles.list}>
      {Array.from({ length: count }).map((_, i) => (
        <View key={i} style={styles.row}>
          <ShimmerBar style={styles.avatar} progress={progress} scheme={resolvedScheme} />
          <View style={styles.lines}>
            <ShimmerBar
              style={[styles.line, { width: `${48 + (i % 3) * 15}%` as `${number}%` }]}
              progress={progress}
              scheme={resolvedScheme}
            />
            <ShimmerBar
              style={[styles.line, { width: `${30 + (i % 4) * 10}%` as `${number}%`, height: 11, marginTop: 6 }]}
              progress={progress}
              scheme={resolvedScheme}
            />
          </View>
        </View>
      ))}
    </View>
  );
}

export function SkeletonKpiGrid() {
  const { palette, resolvedScheme } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const progress = useShimmerProgress();
  return (
    <View style={styles.kpiGrid}>
      {Array.from({ length: 4 }).map((_, i) => (
        <View key={i} style={styles.kpiCard}>
          <ShimmerBar style={[styles.line, { width: '45%', height: 11 }]} progress={progress} scheme={resolvedScheme} />
          <ShimmerBar style={[styles.line, { width: '70%', height: 24, marginTop: 8 }]} progress={progress} scheme={resolvedScheme} />
        </View>
      ))}
    </View>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    list: { paddingTop: spacing[2] },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing[5],
      paddingVertical: spacing[3],
      gap: spacing[3],
    },
    avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: p.border, flexShrink: 0 },
    lines: { flex: 1 },
    line: { height: 14, borderRadius: 6, backgroundColor: p.border },
    kpiGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      paddingHorizontal: spacing[4],
      gap: spacing[3],
      marginTop: spacing[2],
    },
    kpiCard: {
      flex: 1,
      minWidth: '45%',
      backgroundColor: p.surface,
      borderRadius: 12,
      padding: spacing[4],
      borderWidth: 1,
      borderColor: p.border,
    },
  });
}
