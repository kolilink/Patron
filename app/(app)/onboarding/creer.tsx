import { useMemo } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@/src/components/ui/Screen';
import { Text } from '@/src/components/ui/Text';
import { BusinessDetailsStep } from '@/src/components/BusinessDetailsStep';
import { useTheme, radius, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { inferCurrency } from '@/src/constants/currency';

export default function CreerCommerceScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const { createBusiness, loading, error, clearError } = useAuthStore();
  const session     = useAuthStore(s => s.session);
  const memberships = session?.memberships ?? [];
  const alreadyOwns = memberships.some(m => m.role === 'administrateur');

  const handleSubmit = async (data: { name: string; currency: string; referralCode?: string }) => {
    clearError();
    await createBusiness({ name: data.name, currency: data.currency, referralCode: data.referralCode });
    if (!useAuthStore.getState().error) {
      router.replace('/(app)/(tabs)/');
    }
  };

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.kav}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">

          <View style={styles.header}>
            <Pressable onPress={() => router.back()} style={styles.backBtn}>
              <Text variant="body" color="brand">← Retour</Text>
            </Pressable>
            <Text variant="h2">Créer un commerce</Text>
            <Text variant="body" color="secondary">Vous serez automatiquement le Gérant.</Text>
          </View>

          {alreadyOwns ? (
            <View style={styles.lockedBox}>
              <Text variant="body" style={styles.lockedText}>Vous avez déjà un commerce actif.</Text>
              <Text variant="bodySmall" color="secondary">
                Bientôt, vous pourrez en gérer plusieurs depuis Patron.
              </Text>
            </View>
          ) : (
            <BusinessDetailsStep
              loading={loading}
              error={error}
              initialCurrency={inferCurrency(session?.user.phone)}
              onSubmit={handleSubmit}
              showReferralCode
              submitLabel="Créer le commerce"
            />
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    safe:    { flex: 1, backgroundColor: p.background },
    kav:     { flex: 1 },
    content: { flexGrow: 1, padding: spacing[6], gap: spacing[8] },
    header:  { gap: spacing[2] },
    backBtn: { alignSelf: 'flex-start', marginBottom: spacing[2] },

    lockedBox:  { backgroundColor: p.surface, borderRadius: radius.md, borderWidth: 1, borderColor: p.border, padding: spacing[5], gap: spacing[2], alignItems: 'center' },
    lockedText: { textAlign: 'center', fontWeight: '600' as const },
  });
}
