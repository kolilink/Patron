import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  useSharedValue,
  withSpring,
  withTiming,
  useAnimatedStyle,
  Easing,
} from 'react-native-reanimated';
import { Text } from './Text';

interface Props {
  visible: boolean;
  message: string;
}

const SPRING = { mass: 0.4, stiffness: 200, damping: 18 };

export function SaleSuccessOverlay({ visible, message }: Props) {
  const progress = useSharedValue(0);
  const checkW = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      progress.value = withSpring(1, SPRING);
      const t = setTimeout(() => {
        checkW.value = withTiming(22, { duration: 200, easing: Easing.out(Easing.cubic) });
      }, 150);
      return () => clearTimeout(t);
    } else {
      progress.value = withTiming(0, { duration: 150 });
      checkW.value = 0;
    }
  }, [visible]);

  const cardStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ scale: 0.6 + 0.4 * progress.value }],
  }));

  const checkStyle = useAnimatedStyle(() => ({
    width: checkW.value,
  }));

  return (
    <View style={styles.overlay} pointerEvents="none">
      <Animated.View style={[styles.card, cardStyle]}>
        <View style={styles.circle}>
          <Animated.View style={[styles.checkmark, checkStyle]} />
        </View>
        <Text variant="label" style={styles.message}>{message}</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 999,
    elevation: 999,
  },
  card: {
    backgroundColor: 'rgba(10, 10, 10, 0.88)',
    borderRadius: 20,
    paddingVertical: 28,
    paddingHorizontal: 32,
    alignItems: 'center',
    gap: 16,
    minWidth: 200,
  },
  circle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#22c55e',
    justifyContent: 'center',
    alignItems: 'center',
  },
  // Two-border L-shape rotated -45° forms a ✓
  checkmark: {
    height: 13,
    borderLeftWidth: 3,
    borderBottomWidth: 3,
    borderColor: '#fff',
    borderRadius: 1,
    transform: [{ rotate: '-45deg' }],
    marginTop: -3,
  },
  message: {
    color: '#fff',
    textAlign: 'center',
  },
});
