import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@/src/components/ui/Screen';
import { Ionicons } from '@expo/vector-icons';
import { Button } from '@/src/components/ui/Button';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';

export default function AccesSupprime() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
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
    <Screen>
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
              <Text variant="body" style={styles.highlight}>
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
    </Screen>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    safe: {
      flex: 1,
      backgroundColor: p.background,
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
    highlight: { color: p.textPrimary, fontWeight: '600' },
  });
}
