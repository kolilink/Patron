import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Children, cloneElement, isValidElement, useEffect, useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
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
  // Set by MenuGroup — draws a hairline separator below every row except
  // the group's last one, so same-category rows read as one container
  // (Meta Muse's settings-list pattern) instead of N stacked cards.
  divider?: boolean;
}

function MenuRow({ iconName, label, onPress, divider }: MenuRowProps) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.menuRow, divider && styles.menuRowDivider, pressed && styles.menuRowPressed]}
    >
      {/* No background tile behind the glyph, and no brand-purple tint —
          the icon sits directly on the row and inherits the label's own
          text color, so palette.primary stays reserved for real accents
          (the role badge above, the active tab) instead of decorating
          every row the same way. */}
      <View style={styles.menuIconWrap}>
        <Ionicons name={iconName} size={20} color={palette.textPrimary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text variant="label">{label}</Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color={palette.textDisabled} />
    </Pressable>
  );
}

// Wraps same-category MenuRows in a single elevated container, injecting a
// `divider` on every row but the last — replaces the old "one Card per row"
// layout, which cost a full card gap per item.
function MenuGroup({ children }: { children: ReactNode }) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const items = Children.toArray(children);
  return (
    <Card padded={false} elevated style={styles.menuGroup}>
      {items.map((child, i) =>
        isValidElement(child)
          ? cloneElement(child as ReactElement<MenuRowProps>, { divider: i < items.length - 1 })
          : child
      )}
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
                {`Vous êtes ${role === 'administrateur' ? 'Gérant' : role === 'investisseur' ? 'Investisseur' : role === 'manager' ? 'Gérant adjoint' : role.charAt(0).toUpperCase() + role.slice(1)}`}
              </Text>
            </View>
          </View>
        </Card>

        {/* Vendeur section */}
        {isVendeur && (
          <MenuGroup>
            <MenuRow iconName="receipt-outline" label="Mes ventes" onPress={() => router.push('/ventes')} />
            <MenuRow iconName="people-outline" label="Mes clients" onPress={() => router.push('/clients')} />
            <MenuRow iconName="cash-outline" label="Mes dépenses" onPress={() => router.push('/depenses')} />
            <MenuRow iconName="arrow-down-circle-outline" label="Mes apports" onPress={() => router.push('/apports')} />
          </MenuGroup>
        )}

        {/* Investisseur section */}
        {isInvestisseur && (
          <MenuGroup>
            <MenuRow iconName="bar-chart-outline" label="Bilan" onPress={() => router.push('/rapports')} />
            <MenuRow iconName="arrow-down-circle-outline" label="Apports" onPress={() => router.push('/apports')} />
          </MenuGroup>
        )}

        {/* Manager section */}
        {isManager && (
          <>
            <MenuGroup>
              <MenuRow iconName="receipt-outline" label="Ventes" onPress={() => router.push('/ventes')} />
              <MenuRow iconName="people-outline" label="Clients" onPress={() => router.push('/clients')} />
            </MenuGroup>

            <MenuGroup>
              <MenuRow iconName="bar-chart-outline" label="Bilan" onPress={() => router.push('/rapports')} />
              <MenuRow iconName="cash-outline" label="Dépenses" onPress={() => router.push('/depenses')} />
              <MenuRow iconName="arrow-down-circle-outline" label="Apports" onPress={() => router.push('/apports')} />
            </MenuGroup>

            <MenuGroup>
              <MenuRow iconName="business-outline" label="Fournisseurs" onPress={() => router.push('/fournisseurs')} />
            </MenuGroup>
          </>
        )}

        {/* Team + settings — admin only */}
        {isAdmin && (
          <MenuGroup>
            <MenuRow iconName="people-outline" label="Équipe" onPress={() => router.push('/equipe')} />
            <MenuRow iconName="settings-outline" label="Paramètres" onPress={() => router.push('/parametres')} />
          </MenuGroup>
        )}

        {/* Profile — all roles except admin */}
        {!isAdmin && (
          <MenuGroup>
            <MenuRow iconName="person-outline" label="Mon profil" onPress={() => router.push('/parametres')} />
          </MenuGroup>
        )}

        {removedBusinesses.length > 0 && (
          <View style={[styles.section, { marginTop: spacing[3] }]}>
            <Text variant="overline" color="secondary">Anciens commerces</Text>
            <Card padded={false} elevated style={styles.menuGroup}>
              {removedBusinesses.map((b, i) => (
                <Pressable
                  key={b.id}
                  onPress={() => {
                    Alert.alert(
                      b.name,
                      "Vous n'êtes plus membre de ce commerce.\n\nSi vous pensez que c'est une erreur, contactez le gérant.",
                      [
                        {
                          text: 'Compris',
                          onPress: async () => {
                            await dismissRemovedBusiness(session!.user.id, b.id);
                            setRemovedBusinesses(prev => prev.filter(x => x.id !== b.id));
                          },
                        },
                      ],
                    );
                  }}
                  style={({ pressed }) => [
                    styles.oldBusinessRow,
                    i < removedBusinesses.length - 1 && styles.menuRowDivider,
                    pressed && styles.menuRowPressed,
                  ]}
                >
                  <Text variant="label" style={{ opacity: 0.5 }}>{b.name}</Text>
                  <Text variant="caption" color="secondary" style={{ opacity: 0.5 }}>Vous n'êtes plus membre</Text>
                </Pressable>
              ))}
            </Card>
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
    // Single container for a whole category — rows inside are plain
    // Pressables (see menuRow/menuRowDivider), not individual cards.
    menuGroup: { overflow: 'hidden' },
    menuRow: {
      flexDirection: 'row', alignItems: 'center',
      paddingHorizontal: spacing[4], paddingVertical: spacing[5], gap: spacing[3],
    },
    menuRowDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.border },
    menuRowPressed: { opacity: 0.6 },
    // No background/border — a plain sizing slot so the glyph sits directly
    // on the row surface and labels still line up across rows.
    menuIconWrap: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
    oldBusinessRow: { paddingHorizontal: spacing[4], paddingVertical: spacing[4], gap: 2 },
  });
}
