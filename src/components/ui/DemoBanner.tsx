import { useEffect, useRef } from 'react';
import { Animated, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from './Text';
import { colors, useTheme, spacing } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';

export function DemoBanner() {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const isDemoMode = useAuthStore(s => s.session?.isDemoMode);
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!isDemoMode) return;
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.55, duration: 1200, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1,    duration: 1200, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [isDemoMode, opacity]);

  if (!isDemoMode) return null;

  return (
    <View
      style={{
        backgroundColor: palette.primary,
        flexDirection: 'row',
        alignItems: 'center',
        paddingTop: insets.top + spacing[2],
        paddingBottom: spacing[2],
        paddingHorizontal: spacing[5],
        gap: spacing[3],
      }}
    >
      <Text variant="caption" style={{ color: 'colors.neutral[0]', flex: 1 }}>
        Mode essai
      </Text>
      <Pressable onPress={() => router.push('/(welcome)/creer')}>
        <Animated.Text
          style={{
            opacity,
            color: 'colors.neutral[0]',
            fontWeight: '700',
            fontSize: 12,
          }}
        >
          Créer mon commerce →
        </Animated.Text>
      </Pressable>
    </View>
  );
}
