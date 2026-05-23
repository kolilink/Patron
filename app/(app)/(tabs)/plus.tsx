import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Button } from '@/src/components/ui/Button';
import { Card } from '@/src/components/ui/Card';
import { Text } from '@/src/components/ui/Text';
import { colors, palette, spacing } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

const ROLE_COLORS: Record<string, string> = {
  administrateur: colors.role.administrateur,
  manager: colors.role.manager,
  vendeur: colors.role.vendeur,
  investisseur: colors.role.investisseur,
};

interface MenuRowProps {
  iconName: IoniconName;
  label: string;
  sub?: string;
  onPress: () => void;
}

function MenuRow({ iconName, label, sub, onPress }: MenuRowProps) {
  return (
    <Card onPress={onPress} padded={false} style={styles.menuRow}>
      <View style={styles.menuIconWrap}>
        <Ionicons name={iconName} size={20} color={palette.textSecondary} />
      </View>
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

        {/* Vendeur section */}
        {isVendeur && (
          <View style={styles.section}>
            <Text variant="overline" color="secondary">Mes activités</Text>
            <MenuRow iconName="receipt-outline" label="Mes ventes" sub="Historique de mes ventes" onPress={() => router.push('/ventes')} />
            <MenuRow iconName="card-outline" label="Crédits clients" sub="Créances en attente" onPress={() => router.push('/credits')} />
            <MenuRow iconName="people-outline" label="Mes clients" sub="Mes clients et crédits" onPress={() => router.push('/clients')} />
            <MenuRow iconName="cash-outline" label="Dépenses" sub="Soumettre une dépense" onPress={() => router.push('/depenses')} />
          </View>
        )}

        {/* Manager section */}
        {isManager && (
          <>
            <View style={styles.section}>
              <Text variant="overline" color="secondary">Ventes & Clients</Text>
              <MenuRow iconName="receipt-outline" label="Historique des ventes" sub="Toutes les ventes" onPress={() => router.push('/ventes')} />
              <MenuRow iconName="card-outline" label="Crédits clients" sub="Gérer les créances" onPress={() => router.push('/credits')} />
              <MenuRow iconName="people-outline" label="Clients" sub="Informations clients" onPress={() => router.push('/clients')} />
            </View>

            <View style={styles.section}>
              <Text variant="overline" color="secondary">Finances</Text>
              <MenuRow iconName="cash-outline" label="Dépenses" sub="Gérer et approuver les dépenses" onPress={() => router.push('/depenses')} />
            </View>

            <View style={styles.section}>
              <Text variant="overline" color="secondary">Achats</Text>
              <MenuRow iconName="business-outline" label="Fournisseurs" sub="Gérer vos fournisseurs" onPress={() => router.push('/fournisseurs')} />
            </View>

            <View style={styles.section}>
              <Text variant="overline" color="secondary">Analyse</Text>
              <MenuRow iconName="bar-chart-outline" label="Rapports" sub="CA, marges, stock" onPress={() => router.push('/rapports')} />
            </View>
          </>
        )}

        {/* Team + settings — admin only */}
        {isAdmin && (
          <View style={styles.section}>
            <Text variant="overline" color="secondary">Administration</Text>
            <MenuRow iconName="people-outline" label="Équipe" sub="Membres & invitations" onPress={() => router.push('/equipe')} />
            <MenuRow iconName="settings-outline" label="Paramètres" sub="Nom du commerce, devise" onPress={() => router.push('/parametres')} />
          </View>
        )}

        {/* Profile — all roles */}
        {!isAdmin && (
          <View style={styles.section}>
            <Text variant="overline" color="secondary">Mon compte</Text>
            <MenuRow iconName="person-outline" label="Mon profil" sub="Modifier mon nom affiché" onPress={() => router.push('/parametres')} />
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
  menuIconWrap: { width: 28, alignItems: 'center' },
  switchCard: { gap: 2 },
});
