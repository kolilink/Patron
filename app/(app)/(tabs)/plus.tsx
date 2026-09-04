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

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];


interface MenuRowProps {
  iconName: IoniconName;
  label: string;
  onPress: () => void;
}

function MenuRow({ iconName, label, onPress }: MenuRowProps) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  return (
    <Card onPress={onPress} padded={false} elevated style={styles.menuRow}>
      <View style={styles.menuIconWrap}>
        <Ionicons name={iconName} size={18} color={palette.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text variant="label">{label}</Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color={palette.textDisabled} />
    </Card>
  );
}

export default function PlusScreen() {
  const { palette, resolvedScheme } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const session = useAuthStore(s => s.session);
  const logout = useAuthStore(s => s.logout);
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
  const roleColor = (resolvedScheme === 'dark' ? ROLE_COLORS_DARK : ROLE_COLORS_LIGHT)[role] ?? palette.primary;
  const isAdmin = role === 'administrateur';
  const isManager = role === 'manager' || isAdmin;
  const isVendeur = role === 'vendeur';
  const isInvestisseur = role === 'investisseur';

  // A quick re-lock (biometric-recoverable, no OTP needed) is available from
  // Paramètres → "Verrouiller" — this button is for a real sign-out, which now
  // that PIN is gone always requires a fresh WhatsApp OTP to come back.
  const handleLogout = () => {
    Alert.alert(
      'Se déconnecter ?',
      'Vous devrez recevoir un nouveau code WhatsApp pour vous reconnecter.',
      [
        { text: 'Annuler', style: 'cancel' },
        { text: 'Se déconnecter', style: 'destructive', onPress: () => { void logout(); } },
      ],
    );
  };

  return (
    <Screen tab>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* User + business */}
        <Card style={styles.profileCard}>
          <View style={styles.profileRow}>
            <View style={[styles.avatar, { backgroundColor: roleColor + '20' }]}>
              <Text variant="h4" allowFontScaling={false} style={{ color: roleColor }}>
                {(user?.name || generateFallbackName(user?.id ?? ''))[0]?.toUpperCase()}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text variant="label">{user?.name || generateFallbackName(user?.id ?? '')}</Text>
              <Text variant="caption" color="secondary">{user?.email}</Text>
            </View>
            {/* Right-aligned with a marginRight matching the badge's own
                internal padding below, so the last letter lines up with the
                text inside "Vous êtes {role}" rather than the pill's outer
                edge — a deliberate slight inset, not flush to the card edge. */}
            <Text variant="bodySmall" color="secondary" style={styles.bizNameTop} numberOfLines={1}>
              {business?.name}
            </Text>
          </View>
          <View style={styles.bizRow}>
            <View style={[styles.badge, { backgroundColor: roleColor + '20' }]}>
              <Text variant="labelSmall" style={{ color: roleColor }}>
                {`Vous êtes ${role === 'administrateur' ? 'Gérant' : role === 'investisseur' ? 'Observateur' : role.charAt(0).toUpperCase() + role.slice(1)}`}
              </Text>
            </View>
          </View>
        </Card>

        {/* Vendeur section */}
        {isVendeur && (
          <View style={styles.section}>
            <Text variant="overline" color="secondary">Mes activités</Text>
            <MenuRow iconName="receipt-outline" label="Mes ventes" onPress={() => router.push('/ventes')} />
            <MenuRow iconName="people-outline" label="Mes clients" onPress={() => router.push('/clients')} />
            <MenuRow iconName="cash-outline" label="Dépenses" onPress={() => router.push('/depenses')} />
            <MenuRow iconName="arrow-down-circle-outline" label="Mes apports" onPress={() => router.push('/apports')} />
          </View>
        )}

        {/* Investisseur section */}
        {isInvestisseur && (
          <View style={styles.section}>
            <Text variant="overline" color="secondary">Vue d'ensemble</Text>
            <MenuRow iconName="bar-chart-outline" label="Bilan" onPress={() => router.push('/rapports')} />
            <MenuRow iconName="arrow-down-circle-outline" label="Apports" onPress={() => router.push('/apports')} />
          </View>
        )}

        {/* Manager section */}
        {isManager && (
          <>
            <View style={styles.section}>
              <Text variant="overline" color="secondary">Ventes & Clients</Text>
              <MenuRow iconName="receipt-outline" label="Ventes" onPress={() => router.push('/ventes')} />
              <MenuRow iconName="people-outline" label="Clients" onPress={() => router.push('/clients')} />
            </View>

            <View style={styles.section}>
              <Text variant="overline" color="secondary">Argent</Text>
              <MenuRow iconName="bar-chart-outline" label="Bilan" onPress={() => router.push('/rapports')} />
              <MenuRow iconName="cash-outline" label="Dépenses" onPress={() => router.push('/depenses')} />
              <MenuRow iconName="arrow-down-circle-outline" label="Apports" onPress={() => router.push('/apports')} />
            </View>

            <View style={styles.section}>
              <Text variant="overline" color="secondary">Achats</Text>
              <MenuRow iconName="business-outline" label="Fournisseurs" onPress={() => router.push('/fournisseurs')} />
            </View>
          </>
        )}

        {/* Team + settings — admin only */}
        {isAdmin && (
          <View style={styles.section}>
            <Text variant="overline" color="secondary">Administration</Text>
            <MenuRow iconName="people-outline" label="Équipe" onPress={() => router.push('/equipe')} />
            <MenuRow iconName="settings-outline" label="Paramètres" onPress={() => router.push('/parametres')} />
          </View>
        )}

        {/* Profile — all roles except admin */}
        {!isAdmin && (
          <View style={styles.section}>
            <Text variant="overline" color="secondary">Mon compte</Text>
            <MenuRow iconName="person-outline" label="Mon profil" onPress={() => router.push('/parametres')} />
          </View>
        )}

        {removedBusinesses.length > 0 && (
          <View style={[styles.section, { marginTop: spacing[3] }]}>
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
    </Screen>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: p.background },
    content: { paddingHorizontal: spacing[4], paddingTop: spacing[5], gap: spacing[4], paddingBottom: spacing[10] },
    profileCard: { gap: spacing[3] },
    // flex-start (not 'center') so the business name — a plain sibling with
    // no vertical offset of its own — lands at the same y as the first line
    // of the name/email column, per the top-right layout above.
    profileRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing[3] },
    avatar: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
    bizNameTop: {
      maxWidth: 140,
      marginRight: spacing[2], // matches the badge's own paddingHorizontal below
      textAlign: 'right',
    },
    bizRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' },
    badge: { paddingHorizontal: spacing[2], paddingVertical: 2, borderRadius: 6 },
    section: { gap: spacing[2] },
    menuRow: {
      flexDirection: 'row', alignItems: 'center',
      paddingHorizontal: spacing[4], paddingVertical: spacing[5], gap: spacing[3],
    },
    menuIconWrap: {
      width: 32, height: 32, borderRadius: 8,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: p.background,
      borderWidth: 1, borderColor: p.border,
    },
    switchCard: { gap: 2 },
    switchCardActive: { borderWidth: 1.5, borderColor: p.primary },
  });
}
