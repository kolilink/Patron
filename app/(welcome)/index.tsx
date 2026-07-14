import { useEffect, useMemo } from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@/src/components/ui/Screen';
import { Ionicons } from '@expo/vector-icons';
import { Button } from '@/src/components/ui/Button';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';

const SUPPORT_WA_URL = `https://wa.me/16094454809?text=${encodeURIComponent("Bonjour ! J'ai une question sur Patron 🙂")}`;

export default function WelcomeScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const session = useAuthStore(s => s.session);
  const loading = useAuthStore(s => s.loading);
  const startDemoMode = useAuthStore(s => s.startDemoMode);
  const error = useAuthStore(s => s.error);
  const clearError = useAuthStore(s => s.clearError);

  useEffect(() => {
    if (!session) return;
    if (session.activeBusiness) {
      router.replace('/(app)/(tabs)/');
    } else {
      router.replace('/(app)/onboarding/');
    }
  }, [session]);

  return (
    <Screen>
      <View style={styles.content}>
        <View style={styles.hero}>
          <Text variant="display" color="brand" style={styles.logo}>patron</Text>
          <Text variant="h3" style={styles.tagline}>
            Soyez le patron
          </Text>
        </View>

        {error && (
          <Text variant="bodySmall" color="secondary" style={styles.errorText}>{error}</Text>
        )}

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
              label="Se connecter"
              variant="ghost"
              onPress={() => router.push('/(welcome)/connexion')}
              fullWidth
            />
          )}
          {!session && (
            <Button
              label="Essayer Patron"
              variant="ghost"
              onPress={() => { clearError(); startDemoMode(); }}
              loading={loading}
              fullWidth
            />
          )}
        </View>
      </View>

      <Pressable
        style={styles.whatsappCorner}
        onPress={() => Linking.openURL(SUPPORT_WA_URL)}
        hitSlop={12}
      >
        <Ionicons name="logo-whatsapp" size={13} color={palette.textSecondary} />
        <Text variant="caption" color="secondary">WhatsApp</Text>
      </Pressable>
    </Screen>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
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
    tagline: { textAlign: 'center', lineHeight: 30, color: p.textSecondary },
    errorText: { textAlign: 'center', color: p.textSecondary },
    actions: { gap: spacing[3] },
    whatsappCorner: {
      position: 'absolute',
      bottom: spacing[8],
      right: spacing[6],
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing[1],
    },
  });
}
