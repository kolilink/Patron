import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import { useEffect, useMemo, useState } from 'react';
import { router } from 'expo-router';
import { Screen } from '@/src/components/ui/Screen';
import { Ionicons } from '@expo/vector-icons';
import { Button } from '@/src/components/ui/Button';
import { Card } from '@/src/components/ui/Card';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing, ROLE_COLORS as ROLE_COLORS_LIGHT, ROLE_COLORS_DARK } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { generateFallbackName } from '@/lib/id';
import { type KnownBusiness, getKnownBusinesses, dismissRemovedBusiness } from '@/lib/knownBusinesses';
import { hasPinSet, verifyPin } from '@/lib/pin';
import { PinConfirmSheet } from '@/src/components/ui/PinConfirmSheet';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];


interface MenuRowProps {
  iconName: IoniconName;
  label: string;
  sub?: string;
  onPress: () => void;
}

function MenuRow({ iconName, label, sub, onPress }: MenuRowProps) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
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
  const { palette, resolvedScheme } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const session = useAuthStore(s => s.session);
  const lock = useAuthStore(s => s.lock);
  const [removedBusinesses, setRemovedBusinesses] = useState<KnownBusiness[]>([]);
  const [lockConfirmOpen, setLockConfirmOpen] = useState(false);

  useEffect(() => {
    if (!session?.user.id) return;
    getKnownBusinesses(session.user.id).then(all => {
      setRemovedBusinesses(all.filter(b => !b.active));
    });
  }, [session?.user.id]);

  const user = session?.user;
  const business = session?.activeBusiness;
  const role = session?.activeMembership?.role ?? '';
  const roleColor = (resolvedScheme === 'dark' ? ROLE_COLORS_DARK : ROLE_COLORS_LIGHT)[role] ?? palette.primary;
  const isAdmin = role === 'administrateur';
  const isManager = role === 'manager' || isAdmin;
  const isVendeur = role === 'vendeur';
  const isInvestisseur = role === 'investisseur';

  // "Se déconnecter" is PIN-gated rather than an immediate destructive sign-out:
  // existing users who authenticated before this feature shipped may stay
  // mid-session for months and never naturally re-authenticate, so this tap is
  // the only reliable moment to get them onto a PIN. Confirming (or creating)
  // the PIN locks the app instead of fully signing out — no WhatsApp OTP is
  // needed to get back in. A true destructive sign-out (fresh OTP required) is
  // still reachable via the recovery paths on the lock screen (forgotten PIN,
  // "Changer de compte").
  const handleLogout = async () => {
    if (await hasPinSet()) {
      setLockConfirmOpen(true);
    } else {
      router.push({ pathname: '/(auth)/creer-pin', params: { afterLock: '1' } });
    }
  };

  return (
    <Screen tab>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* User + business */}
        <Card style={styles.profileCard}>
          <View style={styles.profileRow}>
            <View style={[styles.avatar, { backgroundColor: roleColor + '20' }]}>
              <Text variant="h4" style={{ color: roleColor }}>
                {(user?.name || generateFallbackName(user?.id ?? ''))[0]?.toUpperCase()}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text variant="label">{user?.name || generateFallbackName(user?.id ?? '')}</Text>
              <Text variant="caption" color="secondary">{user?.email}</Text>
            </View>
          </View>
          <View style={styles.bizRow}>
            <Text variant="bodySmall">{business?.name}</Text>
            <View style={[styles.badge, { backgroundColor: roleColor + '20' }]}>
              <Text variant="labelSmall" style={{ color: roleColor }}>
                {role === 'administrateur' ? 'Gérant' : role === 'investisseur' ? 'Observateur' : role.charAt(0).toUpperCase() + role.slice(1)}
              </Text>
            </View>
          </View>
        </Card>

        {/* Vendeur section */}
        {isVendeur && (
          <View style={styles.section}>
            <Text variant="overline" color="secondary">Mes activités</Text>
            <MenuRow iconName="receipt-outline" label="Mes ventes" sub="Mes ventes passées" onPress={() => router.push('/ventes')} />
            <MenuRow iconName="card-outline" label="Clients qui doivent" sub="Voir qui vous doit de l'argent" onPress={() => router.push('/credits')} />
            <MenuRow iconName="people-outline" label="Mes clients" sub="Mes clients et crédits" onPress={() => router.push('/clients')} />
            <MenuRow iconName="cash-outline" label="Dépenses" sub="Noter une dépense" onPress={() => router.push('/depenses')} />
            <MenuRow iconName="arrow-down-circle-outline" label="Mes apports" sub="Capital que j'ai injecté" onPress={() => router.push('/apports')} />
          </View>
        )}

        {/* Investisseur section */}
        {isInvestisseur && (
          <View style={styles.section}>
            <Text variant="overline" color="secondary">Vue d'ensemble</Text>
            <MenuRow iconName="bar-chart-outline" label="Rapports" sub="Vos chiffres" onPress={() => router.push('/rapports')} />
            <MenuRow iconName="arrow-down-circle-outline" label="Capital investi" sub="Apports de fonds" onPress={() => router.push('/apports')} />
          </View>
        )}

        {/* Manager section */}
        {isManager && (
          <>
            <View style={styles.section}>
              <Text variant="overline" color="secondary">Ventes & Clients</Text>
              <MenuRow iconName="receipt-outline" label="Ventes passées" sub="Toutes les ventes" onPress={() => router.push('/ventes')} />
              <MenuRow iconName="card-outline" label="Clients qui doivent" sub="Voir qui vous doit de l'argent" onPress={() => router.push('/credits')} />
              <MenuRow iconName="people-outline" label="Clients" sub="Informations clients" onPress={() => router.push('/clients')} />
            </View>

            <View style={styles.section}>
              <Text variant="overline" color="secondary">Finances</Text>
              <MenuRow iconName="cash-outline" label="Dépenses" sub="Suivre vos dépenses" onPress={() => router.push('/depenses')} />
              <MenuRow iconName="arrow-down-circle-outline" label="Capital investi" sub="Apports de fonds" onPress={() => router.push('/apports')} />
            </View>

            <View style={styles.section}>
              <Text variant="overline" color="secondary">Achats</Text>
              <MenuRow iconName="business-outline" label="Fournisseurs" sub="Gérer vos fournisseurs" onPress={() => router.push('/fournisseurs')} />
            </View>

            <View style={styles.section}>
              <Text variant="overline" color="secondary">Analyse</Text>
              <MenuRow iconName="bar-chart-outline" label="Rapports" sub="Ventes, gains, stock" onPress={() => router.push('/rapports')} />
            </View>
          </>
        )}

        {/* Team + settings — admin only */}
        {isAdmin && (
          <View style={styles.section}>
            <Text variant="overline" color="secondary">Administration</Text>
            <MenuRow iconName="people-outline" label="Équipe" sub="Membres & invitations" onPress={() => router.push('/equipe')} />
            <MenuRow iconName="settings-outline" label="Paramètres" sub="Nom du commerce, monnaie" onPress={() => router.push('/parametres')} />
          </View>
        )}

        {/* Profile — all roles except admin */}
        {!isAdmin && (
          <View style={styles.section}>
            <Text variant="overline" color="secondary">Mon compte</Text>
            <MenuRow iconName="person-outline" label="Mon profil" sub="Modifier mon nom affiché" onPress={() => router.push('/parametres')} />
          </View>
        )}

        {removedBusinesses.length > 0 && (
          <View style={styles.section}>
            <Text variant="overline" color="secondary">Anciens commerces</Text>
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
          </View>
        )}

        <View style={styles.section}>
          <Button label="Se déconnecter" variant="danger" onPress={handleLogout} fullWidth />
        </View>
      </ScrollView>

      <PinConfirmSheet
        visible={lockConfirmOpen}
        title="Confirmez votre code"
        body="Entrez votre code pour vous déconnecter."
        onCancel={() => setLockConfirmOpen(false)}
        onSubmit={async (pin) => {
          const ok = await verifyPin(pin);
          if (ok) {
            setLockConfirmOpen(false);
            await lock();
          }
          return ok;
        }}
      />
    </Screen>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: p.background },
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
    switchCardActive: { borderWidth: 1.5, borderColor: p.primary },
  });
}
