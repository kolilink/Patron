import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Text } from './Text';
import { useToastStore } from '@/stores/toast';
import { useTheme } from '@/src/theme';
import { radius, spacing } from '@/src/theme';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

export function AppToast() {
  const { palette } = useTheme();
  const { message, type, hide } = useToastStore();
  const insets   = useSafeAreaInsets();
  const slideY   = useRef(new Animated.Value(-120)).current;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const CONFIG: Record<string, { bg: string; color: string; icon: IoniconName }> = {
    success: { bg: palette.successLight, color: palette.success, icon: 'checkmark-circle'   },
    warning: { bg: palette.warningLight, color: palette.warning, icon: 'alert-circle'       },
    info:    { bg: palette.primaryLight, color: palette.primary, icon: 'information-circle' },
  };

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);

    if (message) {
      Animated.spring(slideY, {
        toValue: 0,
        useNativeDriver: true,
        tension: 80,
        friction: 12,
      }).start();

      timerRef.current = setTimeout(() => {
        Animated.timing(slideY, {
          toValue: -120,
          duration: 250,
          useNativeDriver: true,
        }).start(() => hide());
      }, 2500);
    } else {
      Animated.timing(slideY, {
        toValue: -120,
        duration: 250,
        useNativeDriver: true,
      }).start();
    }

    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [message]);

  if (!message) return null;

  const c = CONFIG[type] ?? CONFIG.info;

  return (
    <Animated.View
      style={[
        styles.container,
        { top: insets.top + spacing[3], backgroundColor: c.bg, transform: [{ translateY: slideY }] },
      ]}
    >
      <Ionicons name={c.icon} size={20} color={c.color} />
      <Text variant="bodySmall" style={[styles.label, { color: c.color }]} numberOfLines={2}>
        {message}
      </Text>
    </Animated.View>
  );
}

export function AppToastContainer() {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <AppToast />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: spacing[4],
    right: spacing[4],
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    borderRadius: radius.lg,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 6,
  },
  label: { flex: 1, fontWeight: '600' as const },
});
