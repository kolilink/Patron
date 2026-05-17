import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from '@/src/components/ui/Button';
import { Card } from '@/src/components/ui/Card';
import { Text } from '@/src/components/ui/Text';
import { colors, palette, spacing } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';

const ROLE_COLORS: Record<string, string> = {
  administrateur: colors.role.administrateur,
  manager: colors.role.manager,
  vendeur: colors.role.vendeur,
  investisseur: colors.role.investisseur,
};

interface MenuRowProps { icon: string; label: string; sub?: string; onPress: () => void }
function MenuRow({ icon, label, sub, onPress }: MenuRowProps) {
  return (
    <Card onPress={onPress} padded={false} style={styles.menuRow}>
      <Text style={styles.menuIcon}>{icon}</Text>
      <View style={{ flex: 1 }}>
        <Text variant="label">{label}</Text>
        {sub && <Text variant="caption" color="secondary">{sub}</Text>}
      </View>
      <Text variant="body" color="secondary">›</Text>
    </Card>
  );
}

export default function PlusScreen() {
  const session = useAuthStore(s => s.session);
  const logout = useAuthStore(s => s.logout);
  const selectBusiness = useAuthStore(s => s.selectBusiness);

  const user = session?.user;
  const business = session?.activeBusiness;
  const role = session?.activeMembership?.role ?? '';
  const roleColor = ROLE_COLORS[role] ?? palette.primary;
  const isAdmin = role === 'administrateur';
  const isManager = role === 'manager' || isAdmin;
  const isVendeur = role === 'vendeur';
  const others = session?.memberships.filter(m => m.business_id !== business?.id) ?? [];

  const handleLogout = () => {
    Alert.alert('Déconnexion', 'Voulez-vous vraiment vous déconnecter ?', [
      { text: 'Annuler', style: 'cancel' },
      {
        text: 'Déconnecter', style: 'destructive',
        onPress: async () => { await logout(); router.replace('/(auth)/connexion'); },
      },
    ]);
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text variant="h3">Plus</Text>

        {/* User + business */}
        <Card style={styles.profileCard}>
          <View style={styles.profileRow}>
            <View style={[styles.avatar, { backgroundColor: roleColor + '20' }]}>
              <Text variant="h4" style={{ color: roleColor }}>{user?.name?.[0]?.toUpperCase()}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text variant="label">{user?.name}</Text>
              <Text variant="caption" color="secondary">{user?.email}</Text>
            </View>
          </View>
          <View style={styles.bizRow}>
            <Text variant="bodySmall">{business?.name}</Text>
            <View style={[styles.badge, { backgroundColor: roleColor + '20' }]}>
              <Text variant="labelSmall" style={{ color: roleColor, textTransform: 'capitalize' }}>{role}</Text>
            </View>
          </View>
        </Card>

        {/* Vendeur section — own sales, clients, expenses */}
        {isVendeur && (
          <View style={styles.section}>
            <Text variant="overline" color="secondary">Mes activités</Text>
            <MenuRow icon="🧾" label="Mes ventes" sub="Historique de mes ventes" onPress={() => router.push('/ventes')} />
            <MenuRow icon="👥" label="Mes clients" sub="Mes clients et crédits" onPress={() => router.push('/clients')} />
            <MenuRow icon="💸" label="Dépenses" sub="Soumettre une dépense" onPress={() => router.push('/depenses')} />
          </View>
        )}

        {/* Manager section */}
        {isManager && (
          <>
            <View style={styles.section}>
              <Text variant="overline" color="secondary">Ventes & Clients</Text>
              <MenuRow icon="🧾" label="Historique des ventes" sub="Qui a vendu quoi" onPress={() => router.push('/ventes')} />
              <MenuRow icon="👥" label="Clients & Créances" sub="Dettes clients" onPress={() => router.push('/clients')} />
            </View>

            <View style={styles.section}>
              <Text variant="overline" color="secondary">Finances</Text>
              <MenuRow icon="💸" label="Dépenses" sub="Gérer et approuver les dépenses" onPress={() => router.push('/depenses')} />
            </View>

            <View style={styles.section}>
              <Text variant="overline" color="secondary">Achats</Text>
              <MenuRow icon="🏭" label="Fournisseurs" sub="Gérer vos fournisseurs" onPress={() => router.push('/fournisseurs')} />
            </View>

            <View style={styles.section}>
              <Text variant="overline" color="secondary">Analyse</Text>
              <MenuRow icon="📊" label="Rapports" sub="CA, marges, stock" onPress={() => router.push('/rapports')} />
            </View>
          </>
        )}

        {/* Team + settings — admin only */}
        {isAdmin && (
          <View style={styles.section}>
            <Text variant="overline" color="secondary">Administration</Text>
            <MenuRow icon="👤" label="Équipe" sub="Membres & invitations" onPress={() => router.push('/equipe')} />
            <MenuRow icon="⚙️" label="Paramètres" sub="Commerce, devise" onPress={() => router.push('/parametres')} />
          </View>
        )}

        {/* Switch business */}
        {others.length > 0 && (
          <View style={styles.section}>
            <Text variant="overline" color="secondary">Autres commerces</Text>
            {others.map(m => (
              <Card key={m.id} onPress={() => { selectBusiness(m.business_id); router.replace('/(app)/(tabs)/'); }}
                style={styles.switchCard}>
                <Text variant="label">{(m.business as { name?: string })?.name ?? m.business_id}</Text>
                <Text variant="caption" color="secondary" style={{ textTransform: 'capitalize' }}>{m.role}</Text>
              </Card>
            ))}
          </View>
        )}

        <Button label="Se déconnecter" variant="danger" onPress={handleLogout} fullWidth />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.background },
  content: { padding: spacing[5], gap: spacing[4], paddingBottom: spacing[10] },
  profileCard: { gap: spacing[3] },
  profileRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  avatar: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  bizRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  badge: { paddingHorizontal: spacing[2], paddingVertical: 2, borderRadius: 6 },
  section: { gap: spacing[2] },
  menuRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: spacing[4], paddingVertical: spacing[3], gap: spacing[3],
  },
  menuIcon: { fontSize: 20, width: 28, textAlign: 'center' },
  switchCard: { gap: 2 },
});
