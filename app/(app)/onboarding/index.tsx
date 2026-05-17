import { StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Card } from '@/src/components/ui/Card';
import { Text } from '@/src/components/ui/Text';
import { palette, spacing } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';

export default function OnboardingScreen() {
  const user = useAuthStore(s => s.session?.user);

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.content}>
        <View style={styles.header}>
          <Text variant="display" color="brand" style={styles.logo}>patron</Text>
          <Text variant="h3">Bienvenue, {user?.name?.split(' ')[0]} !</Text>
          <Text variant="body" color="secondary" style={styles.subtitle}>
            Commencez par créer votre commerce ou rejoignez-en un avec un code d'invitation.
          </Text>
        </View>

        <View style={styles.cards}>
          <Card onPress={() => router.push('/(app)/onboarding/creer')} elevated style={styles.card}>
            <Text style={styles.cardIcon}>🏪</Text>
            <Text variant="h4">Créer un commerce</Text>
            <Text variant="bodySmall" color="secondary" style={styles.cardDesc}>
              Vous êtes propriétaire ou gérant. Vous aurez le rôle d'Administrateur.
            </Text>
          </Card>

          <Card onPress={() => router.push('/(app)/onboarding/rejoindre')} style={styles.card}>
            <Text style={styles.cardIcon}>🔗</Text>
            <Text variant="h4">Rejoindre avec un code</Text>
            <Text variant="bodySmall" color="secondary" style={styles.cardDesc}>
              Un collègue vous a partagé un code d'invitation ? Entrez-le ici.
            </Text>
          </Card>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.background },
  content: {
    flex: 1,
    padding: spacing[6],
    justifyContent: 'center',
    gap: spacing[10],
  },
  header: { alignItems: 'center', gap: spacing[3] },
  logo: { letterSpacing: -1 },
  subtitle: { textAlign: 'center', maxWidth: 280 },
  cards: { gap: spacing[4] },
  card: { gap: spacing[2] },
  cardIcon: { fontSize: 32 },
  cardDesc: { marginTop: spacing[1] },
});
