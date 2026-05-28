import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from '@/src/components/ui/Button';
import { Text } from '@/src/components/ui/Text';
import { palette, spacing } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';

export default function WelcomeScreen() {
  const session = useAuthStore(s => s.session);
  const loading = useAuthStore(s => s.loading);

  useEffect(() => {
    if (!loading && session?.activeBusiness) {
      router.replace('/(app)/(tabs)/');
    }
  }, [loading, session?.activeBusiness]);

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.content}>
        <View style={styles.hero}>
          <Text variant="display" color="brand" style={styles.logo}>patron</Text>
          <Text variant="h3" style={styles.tagline}>
            Suivez votre marchandise, gérez vos fournisseurs, et contrôlez l'argent que vos clients vous doivent simplement.
          </Text>
        </View>

        <View style={styles.actions}>
          <Button
            label="Créer mon commerce"
            onPress={() => router.push('/(welcome)/creer')}
            fullWidth
            size="lg"
          />
          <Button
            label="Rejoindre un commerce"
            variant="secondary"
            onPress={() => router.push('/(welcome)/rejoindre')}
            fullWidth
            size="lg"
          />
          {!session && (
            <Button
              label="J'ai déjà un compte"
              variant="ghost"
              onPress={() => router.push('/(welcome)/connexion')}
              fullWidth
            />
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.background },
  content: {
    flex: 1,
    paddingHorizontal: spacing[8],
    paddingVertical: spacing[10],
    justifyContent: 'center',
    gap: spacing[16],
  },
  hero: {
    alignItems: 'center',
    gap: spacing[5],
  },
  logo: { letterSpacing: -1 },
  tagline: { textAlign: 'center', lineHeight: 30, color: palette.textSecondary },
  actions: { gap: spacing[3] },
});
