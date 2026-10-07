import { useMemo, useRef } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Screen } from '@/src/components/ui/Screen';
import { Ionicons } from '@expo/vector-icons';
import { Button } from '@/src/components/ui/Button';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { openSupportChat } from '@/src/utils/whatsapp';
import { useSessionRedirect } from '@/src/hooks/useSessionRedirect';
import { createTapGuard } from '@/src/utils/navGuard';

export default function WelcomeScreen() {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const session = useAuthStore(s => s.session);
  const error = useAuthStore(s => s.error);

  // A session means the guard below is already taking her to the app: a tap here
  // must not start a second navigation that the redirect then lands on top of.
  useSessionRedirect();
  const tapGuard = useRef(createTapGuard()).current;
  const go = (path: '/(welcome)/creer' | '/(welcome)/rejoindre' | '/(welcome)/connexion') => {
    if (useAuthStore.getState().session) return;   // synchronous: the store, not a stale render
    if (!tapGuard.allow()) return;                  // a fast double-tap yields ONE transition
    router.push(path);
  };

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
          <Text variant="bodySmall" color="danger" style={styles.errorText}>{error}</Text>
        )}

        <View style={styles.actions}>
          <Button
            label="Ajouter mon commerce"
            onPress={() => go('/(welcome)/creer')}
            fullWidth
            size="lg"
          />
          <Button
            label="Rejoindre un commerce"
            variant="secondary"
            onPress={() => go('/(welcome)/rejoindre')}
            fullWidth
            size="lg"
          />
          {!session && (
            <Button
              label="Se connecter"
              variant="ghost"
              onPress={() => go('/(welcome)/connexion')}
              fullWidth
            />
          )}
        </View>
      </View>

      <Pressable style={[styles.whatsappCorner, { bottom: insets.bottom + spacing[6] }]} onPress={openSupportChat} hitSlop={12}>
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
    errorText: { textAlign: 'center' },
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
