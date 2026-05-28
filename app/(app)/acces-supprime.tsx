import { StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Button } from '@/src/components/ui/Button';
import { Text } from '@/src/components/ui/Text';
import { palette, spacing } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';

export default function AccesSupprime() {
  const removedBusinessName = useAuthStore(s => s.removedBusinessName);
  const removedBusinessesOnLogin = useAuthStore(s => s.removedBusinessesOnLogin);
  const clearRemovedBusiness = useAuthStore(s => s.clearRemovedBusiness);
  const clearRemovedBusinessesOnLogin = useAuthStore(s => s.clearRemovedBusinessesOnLogin);

  const displayName = removedBusinessName ?? removedBusinessesOnLogin?.[0]?.name ?? null;

  const clearAll = () => {
    clearRemovedBusiness();
    clearRemovedBusinessesOnLogin();
  };

  const handleCreate = () => {
    clearAll();
    router.replace('/(welcome)/creer');
  };

  const handleJoin = () => {
    clearAll();
    router.replace('/(welcome)/rejoindre');
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>

        <View style={styles.iconWrap}>
          <Ionicons name="storefront-outline" size={56} color={palette.textSecondary} />
        </View>

        <View style={styles.body}>
          <Text variant="h2" style={styles.title}>
            Vous n'êtes plus membre de ce commerce
          </Text>

          {displayName ? (
            <Text variant="body" color="secondary" style={styles.line}>
              Vous n'êtes plus membre de{' '}
              <Text variant="body" style={{ color: palette.textPrimary, fontWeight: '600' }}>
                « {displayName} »
              </Text>
              {'.'} Si vous pensez que c'est une erreur, contactez son gérant.
            </Text>
          ) : (
            <Text variant="body" color="secondary" style={styles.line}>
              Vous n'êtes plus membre de ce commerce. Si vous pensez que c'est une erreur, contactez son gérant.
            </Text>
          )}
        </View>

        <View style={styles.actions}>
          <Button
            label="Créer mon commerce"
            fullWidth
            size="lg"
            onPress={handleCreate}
          />
          <Button
            label="Rejoindre un commerce"
            variant="secondary"
            fullWidth
            size="lg"
            onPress={handleJoin}
          />
        </View>

      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: palette.background,
  },
  container: {
    flex: 1,
    paddingHorizontal: spacing[8],
    paddingBottom: spacing[10],
    justifyContent: 'center',
  },
  iconWrap: {
    alignItems: 'center',
    marginBottom: spacing[8],
  },
  body: {
    gap: spacing[4],
    marginBottom: spacing[10],
  },
  title: {
    lineHeight: 34,
    textAlign: 'center',
  },
  line: {
    textAlign: 'center',
    lineHeight: 24,
  },
  actions: {
    gap: spacing[3],
  },
});
