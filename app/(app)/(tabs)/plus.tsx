import { Alert, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from '@/src/components/ui/Button';
import { Card } from '@/src/components/ui/Card';
import { Text } from '@/src/components/ui/Text';
import { colors, palette, spacing } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';

const ROLE_LABELS: Record<string, string> = {
  administrateur: 'Administrateur',
  manager: 'Manager',
  vendeur: 'Vendeur',
  investisseur: 'Investisseur',
};

const ROLE_COLORS: Record<string, string> = {
  administrateur: colors.role.administrateur,
  manager: colors.role.manager,
  vendeur: colors.role.vendeur,
  investisseur: colors.role.investisseur,
};

export default function PlusScreen() {
  const session = useAuthStore(s => s.session);
  const logout = useAuthStore(s => s.logout);
  const selectBusiness = useAuthStore(s => s.selectBusiness);

  const user = session?.user;
  const business = session?.activeBusiness;
  const role = session?.activeMembership?.role ?? '';
  const otherMemberships = session?.memberships.filter(
    m => m.business_id !== business?.id
  ) ?? [];

  const handleLogout = () => {
    Alert.alert(
      'Déconnexion',
      'Voulez-vous vraiment vous déconnecter ?',
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Déconnecter',
          style: 'destructive',
          onPress: async () => {
            await logout();
            router.replace('/(auth)/connexion');
          },
        },
      ]
    );
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.content}>
        <Text variant="h2">Plus</Text>

        {/* User info */}
        <Card style={styles.section}>
          <Text variant="label" color="secondary">Compte</Text>
          <Text variant="h4">{user?.name}</Text>
          <Text variant="bodySmall" color="secondary">{user?.email}</Text>
        </Card>

        {/* Active business */}
        <Card style={styles.section}>
          <Text variant="label" color="secondary">Commerce actif</Text>
          <View style={styles.businessRow}>
            <Text variant="h4" style={styles.businessName}>{business?.name}</Text>
            <View style={[styles.roleBadge, { backgroundColor: ROLE_COLORS[role] + '20' }]}>
              <Text
                variant="labelSmall"
                style={{ color: ROLE_COLORS[role] }}
              >
                {ROLE_LABELS[role] ?? role}
              </Text>
            </View>
          </View>
          <Text variant="bodySmall" color="secondary">Devise : {business?.currency}</Text>
        </Card>

        {/* Switch business */}
        {otherMemberships.length > 0 && (
          <Card style={styles.section}>
            <Text variant="label" color="secondary">Autres commerces</Text>
            {otherMemberships.map(m => (
              <Card
                key={m.id}
                onPress={() => {
                  selectBusiness(m.business_id);
                  router.replace('/(app)/(tabs)/');
                }}
                style={styles.switchCard}
              >
                <Text variant="body">{(m.business as { name?: string })?.name ?? m.business_id}</Text>
                <Text variant="labelSmall" color="secondary" style={{ textTransform: 'capitalize' }}>
                  {m.role}
                </Text>
              </Card>
            ))}
          </Card>
        )}

        <View style={styles.spacer} />

        <Button
          label="Se déconnecter"
          variant="danger"
          onPress={handleLogout}
          fullWidth
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.background },
  content: { flex: 1, padding: spacing[5], gap: spacing[4] },
  section: { gap: spacing[2] },
  businessRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3], flexWrap: 'wrap' },
  businessName: { flex: 1 },
  roleBadge: {
    paddingHorizontal: spacing[2],
    paddingVertical: spacing[0.5],
    borderRadius: 6,
  },
  switchCard: { marginTop: spacing[1] },
  spacer: { flex: 1 },
});
