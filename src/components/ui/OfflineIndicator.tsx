import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Platform, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing, radius } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useConnectivityStore } from '@/lib/connectivity';
import { useReduceMotion } from '@/src/hooks/useReduceMotion';

/**
 * The one offline indicator: a small quiet pill OVERLAID at the top centre —
 * absolutely positioned, never in the layout flow, so it cannot shift content
 * or collide with the header. Sits just below the status bar / notch
 * (safe-area aware, iOS + Android), ignores touches, fades in/out. Shown when
 * the device reports no network, or a screen is showing offline data.
 */
export function OfflineIndicator() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotion();
  const rawOffline = useConnectivityStore(s => !s.online || s.offlineViews > 0);
  // Hysteresis: appear only once offline has held for a moment, vanish only once
  // online has held — rapid flapping never makes the pill flicker.
  const [offline, setOffline] = useState(rawOffline);
  useEffect(() => {
    const t = setTimeout(() => setOffline(rawOffline), rawOffline ? 500 : 900);
    return () => clearTimeout(t);
  }, [rawOffline]);
  const opacity = useRef(new Animated.Value(offline ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(opacity, {
      toValue: offline ? 1 : 0,
      duration: reduceMotion ? 0 : 180,
      useNativeDriver: true,
    }).start();
  }, [offline, opacity, reduceMotion]);

  return (
    <View
      pointerEvents="none"
      style={[styles.wrap, { top: insets.top + (Platform.OS === 'android' ? 4 : 2) }]}
      accessibilityElementsHidden={!offline}
    >
      <Animated.View style={[styles.pill, { opacity }]}>
        <Ionicons name="cloud-offline-outline" size={12} color={palette.textSecondary} />
        <Text variant="caption" style={{ color: palette.textSecondary }}>Hors ligne</Text>
      </Animated.View>
    </View>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 50, elevation: 50 },
    pill: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[1],
      paddingHorizontal: spacing[3], paddingVertical: 3,
      borderRadius: radius.full,
      backgroundColor: p.surfaceElevated,
      borderWidth: StyleSheet.hairlineWidth, borderColor: p.border,
    },
  });
}
