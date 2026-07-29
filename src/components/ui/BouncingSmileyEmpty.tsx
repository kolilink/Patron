import { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from './Text';
import { useTheme, spacing, radius } from '@/src/theme';

interface BouncingSmileyEmptyProps {
  // Omit both when a screen already has its own persistent "+" (e.g. a FAB) —
  // the empty state then shows only the smiley, no second/duplicate CTA.
  ctaLabel?: string;
  onPress?: () => void;
}

// Shared "nothing here, and that's good" empty state — a colorless smiley that
// bounces gently in place (core Animated API, native driver, no extra library),
// with an optional outlined CTA underneath. No title, no hint copy, no icon
// border/background: intentionally the same look and position everywhere it's
// used, so screens using it read as one consistent moment, not a per-screen
// redesign. Reused by Credits ("Tout est soldé"), Fournisseurs ("Vos
// fournisseurs"), Dépenses, and Ventes (the last two have their own FAB, so
// no ctaLabel/onPress is passed there).
export function BouncingSmileyEmpty({ ctaLabel, onPress }: BouncingSmileyEmptyProps) {
  const { palette } = useTheme();
  const bounceAnim = useRef(new Animated.Value(0)).current;
  const hasCta = Boolean(ctaLabel && onPress);

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(bounceAnim, { toValue: -8, duration: 650, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(bounceAnim, { toValue: 0, duration: 650, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [bounceAnim]);

  return (
    <View style={{ alignItems: 'center' }}>
      <Animated.View
        style={{
          width: 88, height: 88, alignItems: 'center', justifyContent: 'center',
          marginBottom: hasCta ? spacing[5] : 0, transform: [{ translateY: bounceAnim }],
        }}
      >
        <Ionicons name="happy-outline" size={64} color={palette.textDisabled} />
      </Animated.View>
      {hasCta && (
        <Pressable
          onPress={onPress}
          style={({ pressed }) => [
            {
              paddingVertical: spacing[3], paddingHorizontal: spacing[6],
              borderWidth: 1, borderRadius: radius.md, borderColor: palette.primary,
              opacity: pressed ? 0.7 : 1,
            },
          ]}
        >
          <Text variant="label" style={{ color: palette.primary }}>{ctaLabel}</Text>
        </Pressable>
      )}
    </View>
  );
}
