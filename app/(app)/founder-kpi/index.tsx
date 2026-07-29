import { useEffect, useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@/src/components/ui/Screen';
import { Text } from '@/src/components/ui/Text';
import { FounderDashboard } from '@/src/components/FounderDashboard';
import { useTheme, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { isFounderPhone } from '@/src/utils/founder';

// Founder-only real-time growth panel — reached from BusinessDrawer's "KPI"
// footer row, same pattern as "Service client" → support-inbox. FounderDashboard
// itself refetches on every focus, so re-opening this screen always shows the
// current numbers rather than whatever was cached from the last visit.
export default function FounderKpiScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const session = useAuthStore(s => s.session);
  const isFounder = isFounderPhone(session?.user.phone);

  useEffect(() => {
    if (!isFounder) {
      if (router.canGoBack()) router.back();
      else router.replace('/(app)/(tabs)/');
    }
  }, [isFounder]);

  if (!isFounder) return null;

  return (
    <Screen>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()}>
          <Text variant="body" color="secondary">‹ Retour</Text>
        </Pressable>
        <View style={{ alignItems: 'center' }}>
          <Text variant="h4">KPI</Text>
          <Text variant="caption" color="secondary" numberOfLines={1}>Croissance — en temps réel</Text>
        </View>
        <View style={{ width: 60 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <FounderDashboard />
      </ScrollView>
    </Screen>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: spacing[5],
      borderBottomWidth: 1,
      borderBottomColor: p.border,
    },
    content: {
      padding: spacing[5],
    },
  });
}
