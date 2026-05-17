import { useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  withDelay,
} from 'react-native-reanimated';
import { Text } from '@/src/components/ui/Text';
import { colors, palette, radius, shadow, spacing } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

interface OptionCardProps {
  icon: IoniconName;
  title: string;
  desc: string;
  accentColor: string;
  onPress: () => void;
  pulseDelay?: number;
}

function OptionCard({ icon, title, desc, accentColor, onPress, pulseDelay = 0 }: OptionCardProps) {
  const pulse = useSharedValue(0.35);

  useEffect(() => {
    pulse.value = withDelay(
      pulseDelay,
      withRepeat(
        withSequence(
          withTiming(1, { duration: 950 }),
          withTiming(0.35, { duration: 950 }),
        ),
        -1
      )
    );
  }, []);

  const accentStyle = useAnimatedStyle(() => ({
    opacity: pulse.value,
  }));

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
    >
      <Animated.View style={[styles.accent, { backgroundColor: accentColor }, accentStyle]} />

      <View style={[styles.iconWrap, { backgroundColor: accentColor + '18' }]}>
        <Ionicons name={icon} size={26} color={accentColor} />
      </View>

      <View style={styles.cardBody}>
        <Text variant="h4">{title}</Text>
        <Text variant="bodySmall" color="secondary" style={styles.cardDesc}>{desc}</Text>
      </View>

      <Ionicons name="chevron-forward" size={20} color={palette.textDisabled} />
    </Pressable>
  );
}

export default function OnboardingScreen() {
  const firstName = useAuthStore(s => s.session?.user.name?.split(' ')[0]);

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.content}>
        <View style={styles.header}>
          <Text variant="display" color="brand" style={styles.logo}>patron</Text>
          <Text variant="h3">
            {firstName ? `Bienvenue, ${firstName} !` : 'Bienvenue !'}
          </Text>
          <Text variant="body" color="secondary" style={styles.subtitle}>
            Comment voulez-vous commencer ?
          </Text>
        </View>

        <View style={styles.cards}>
          <OptionCard
            icon="storefront-outline"
            title="Créer un commerce"
            desc="Vous êtes propriétaire ou gérant. Vous aurez le rôle d'Administrateur."
            accentColor={colors.primary[600]}
            onPress={() => router.push('/(app)/onboarding/creer')}
            pulseDelay={0}
          />
          <OptionCard
            icon="people-outline"
            title="Rejoindre avec un code"
            desc="Un collègue vous a partagé un code d'invitation."
            accentColor={colors.success[600]}
            onPress={() => router.push('/(app)/onboarding/rejoindre')}
            pulseDelay={950}
          />
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.background },
  content: {
    flex: 1,
    paddingHorizontal: spacing[5],
    paddingVertical: spacing[8],
    justifyContent: 'center',
    gap: spacing[12],
  },
  header: { alignItems: 'center', gap: spacing[3] },
  logo: { letterSpacing: -1 },
  subtitle: { textAlign: 'center' },

  cards: { gap: spacing[4] },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: palette.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: palette.border,
    overflow: 'hidden',
    paddingVertical: spacing[5],
    paddingRight: spacing[4],
    gap: spacing[3],
    ...shadow.md,
  },
  cardPressed: { opacity: 0.82 },
  accent: {
    width: 4,
    alignSelf: 'stretch',
  },
  iconWrap: {
    width: 48,
    height: 48,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardBody: { flex: 1 },
  cardDesc: { marginTop: spacing[1] },
});
