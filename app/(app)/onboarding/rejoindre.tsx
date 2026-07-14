import { StyleSheet, View } from 'react-native';
import { Pressable } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@/src/components/ui/Screen';
import { Button } from '@/src/components/ui/Button';
import { Text } from '@/src/components/ui/Text';
import { JoinCodeStep } from '@/src/components/JoinCodeStep';
import { useMemo } from 'react';
import { useTheme, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';

export default function RejoindreScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const { joinBusiness, loading, error, clearError } = useAuthStore();
  const isDemoMode = useAuthStore(s => s.session?.isDemoMode);

  // Demo users have no phone — show a gate instead of the join form.
  // Using an inline render (not a redirect) so the ← Retour button works correctly.
  if (isDemoMode) {
    return (
      <Screen>
        <View style={styles.content}>
          <View style={styles.header}>
            <Pressable onPress={() => router.back()} style={styles.backBtn}>
              <Text variant="body" color="brand">← Retour</Text>
            </Pressable>
            <Text variant="h2">Rejoindre un commerce</Text>
            <Text variant="body" color="secondary">
              Pour rejoindre un commerce, vous devez d'abord créer votre compte et vérifier votre numéro.
            </Text>
          </View>
          <Button
            label="Créer mon compte →"
            onPress={() => router.push('/(welcome)/rejoindre')}
            fullWidth
          />
        </View>
      </Screen>
    );
  }

  const handleSubmit = async (code: string) => {
    clearError();
    await joinBusiness(code);
    if (!useAuthStore.getState().error) {
      router.replace('/(app)/(tabs)/');
    }
  };

  return (
    <Screen>
      <View style={styles.content}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.backBtn}>
            <Text variant="body" color="brand">← Retour</Text>
          </Pressable>
          <Text variant="h2">Rejoindre un commerce</Text>
          <Text variant="body" color="secondary">
            Entrez le code d'invitation partagé par votre partenaire :)
          </Text>
        </View>

        <JoinCodeStep loading={loading} error={error} onSubmit={handleSubmit} />
      </View>
    </Screen>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: p.background },
    content: { flex: 1, padding: spacing[6], gap: spacing[8] },
    header: { gap: spacing[2] },
    backBtn: { alignSelf: 'flex-start', marginBottom: spacing[2] },
  });
}
