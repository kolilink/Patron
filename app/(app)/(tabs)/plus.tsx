import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import { useEffect, useState } from 'react';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Button } from '@/src/components/ui/Button';
import { Card } from '@/src/components/ui/Card';
import { Text } from '@/src/components/ui/Text';
import { colors, palette, spacing } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { type KnownBusiness, getKnownBusinesses, dismissRemovedBusiness } from '@/lib/knownBusinesses';

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
  const [removedBusinesses, setRemovedBusinesses] = useState<KnownBusiness[]>([]);

  useEffect(() => {
    if (!session?.user.id) return;
    getKnownBusinesses(session.user.id).then(all => {
      setRemovedBusinesses(all.filter(b => !b.active));
    });
  }, [session?.user.id]);

  const user = session?.user;
  const business = session?.activeBusiness;
  const role = session?.activeMembership?.role ?? '';
  const roleColor = ROLE_COLORS[role] ?? palette.primary;
  const isAdmin = role === 'administrateur';
  const isManager = role === 'manager' || isAdmin;
  const isVendeur = role === 'vendeur';
  const isInvestisseur = role === 'investisseur';

  const handleLogout = () => {
    Alert.alert('Déconnexion', 'Voulez-vous vraiment vous déconnecter ?', [
      { text: 'Annuler', style: 'cancel' },
      {
        text: 'Déconnecter', style: 'destructive',
        onPress: async () => { await logout(); router.replace('/(welcome)/'); },
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
              <Text variant="labelSmall" style={{ color: roleColor }}>
                {role === 'administrateur' ? 'Gérant' : role.charAt(0).toUpperCase() + role.slice(1)}
              </Text>
            </View>
          </View>
        </Card>

        {/* Vendeur section */}
        {isVendeur && (
          <View style={styles.section}>
            <Text variant="overline" color="secondary">Mes activités</Text>
            <MenuRow iconName="receipt-outline" label="Mes ventes" sub="Historique de mes ventes" onPress={() => router.push('/ventes')} />
            <MenuRow iconName="card-outline" label="Clients qui doivent" sub="Voir qui te doit de l'argent" onPress={() => router.push('/credits')} />
            <MenuRow iconName="people-outline" label="Mes clients" sub="Mes clients et crédits" onPress={() => router.push('/clients')} />
            <MenuRow iconName="cash-outline" label="Dépenses" sub="Soumettre une dépense" onPress={() => router.push('/depenses')} />
          </View>
        )}

        {/* Investisseur section */}
        {isInvestisseur && (
          <View style={styles.section}>
            <Text variant="overline" color="secondary">Vue d'ensemble</Text>
            <MenuRow iconName="bar-chart-outline" label="Rapports" sub="Revenus, stock, créances" onPress={() => router.push('/rapports')} />
          </View>
        )}

        {/* Manager section */}
        {isManager && (
          <>
            <View style={styles.section}>
              <Text variant="overline" color="secondary">Ventes & Clients</Text>
              <MenuRow iconName="receipt-outline" label="Historique des ventes" sub="Toutes les ventes" onPress={() => router.push('/ventes')} />
              <MenuRow iconName="card-outline" label="Clients qui doivent" sub="Voir qui te doit de l'argent" onPress={() => router.push('/credits')} />
              <MenuRow iconName="people-outline" label="Clients" sub="Informations clients" onPress={() => router.push('/clients')} />
            </View>

            <View style={styles.section}>
              <Text variant="overline" color="secondary">Finances</Text>
              <MenuRow iconName="cash-outline" label="Dépenses" sub="Suivre tes dépenses" onPress={() => router.push('/depenses')} />
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

        {/* Profile — all roles except admin */}
        {!isAdmin && (
          <View style={styles.section}>
            <Text variant="overline" color="secondary">Mon compte</Text>
            <MenuRow iconName="person-outline" label="Mon profil" sub="Modifier mon nom affiché" onPress={() => router.push('/parametres')} />
          </View>
        )}

        {/* Switch business + join */}
        <View style={styles.section}>
          <Text variant="overline" color="secondary">Mes commerces</Text>
          {session?.memberships.map(m => (
            <Card
              key={m.id}
              onPress={m.business_id !== business?.id ? () => { selectBusiness(m.business_id); router.replace('/(app)/(tabs)/'); } : undefined}
              style={[styles.switchCard, m.business_id === business?.id && styles.switchCardActive]}
            >
              <View style={{ flex: 1 }}>
                <Text variant="label">{(m.business as { name?: string })?.name ?? m.business_id}</Text>
                <Text variant="caption" color="secondary" style={{ textTransform: 'capitalize' }}>{m.role}</Text>
              </View>
              {m.business_id === business?.id && (
                <Text variant="caption" style={{ color: palette.primary }}>Actif</Text>
              )}
            </Card>
          ))}
          {removedBusinesses.map(b => (
            <Card
              key={b.id}
              onPress={() => {
                Alert.alert(
                  b.name,
                  "Vous n'êtes plus membre de ce commerce.\n\nSi vous pensez que c'est une erreur, contactez le gérant.",
                  [
                    {
                      text: 'Fermer',
                      onPress: async () => {
                        await dismissRemovedBusiness(session!.user.id, b.id);
                        setRemovedBusinesses(prev => prev.filter(x => x.id !== b.id));
                      },
                    },
                  ],
                );
              }}
              style={[styles.switchCard, { opacity: 0.5 }]}
            >
              <View style={{ flex: 1 }}>
                <Text variant="label">{b.name}</Text>
                <Text variant="caption" color="secondary">Vous n'êtes plus membre</Text>
              </View>
            </Card>
          ))}
          {(session?.memberships.length ?? 0) < 2 && (
            <MenuRow
              iconName="add-circle-outline"
              label="Rejoindre un commerce"
              sub="Entrer un code d'invitation"
              onPress={() => router.push('/(app)/onboarding/rejoindre')}
            />
          )}
        </View>

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
  switchCardActive: { borderWidth: 1.5, borderColor: palette.primary },
});
