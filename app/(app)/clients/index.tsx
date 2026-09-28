import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Linking, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { Screen } from '@/src/components/ui/Screen';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/src/components/ui/Text';
import { Input } from '@/src/components/ui/Input';
import { NoResultsState } from '@/src/components/ui/NoResultsState';
import { useTheme, spacing, radius, fontFamily, AVATAR_PALETTE, SEARCH_VISIBILITY_THRESHOLD } from '@/src/theme';
import { useAnimateLayoutChange } from '@/src/hooks/useAnimateLayoutChange';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useVentesStore } from '@/stores/ventes';
import { OfflineNotice } from '@/src/components/ui/OfflineNotice';
import { SkeletonList } from '@/src/components/ui/SkeletonPlaceholder';
import { buildDebtReminderMessage, formatDebtAge, debtAgeTier } from '@/src/utils/clientReminder';

function fmt(n: number, cur: string) { return `${Math.round(n).toLocaleString('fr-FR')} ${cur}`; }

// Maps the shared age tier to this screen's actual palette tokens — kept
// here rather than in clientReminder.ts since that file has no theme context.
function debtAgeColor(days: number, palette: Palette): string {
  const tier = debtAgeTier(days);
  if (tier === 'urgent') return palette.recouvrementOwed;
  if (tier === 'attention') return palette.recouvrementPending;
  return palette.textSecondary;
}

// Clamped to zero — a debt dated "today" must never read as a negative day
// count. This can otherwise go negative when dateStr was extracted from a
// UTC created_at (`.split('T')[0]`) and then reconstructed as *local*
// midnight: on a device west of UTC, a sale made late in the UTC day still
// falls on "today" locally, but its UTC date substring is already
// "tomorrow" — reconstructing that as local midnight puts it in the future
// relative to `Date.now()`, so the subtraction below goes negative. "Depuis"
// must never be negative regardless of which timezone is viewing it.
function getDaysAgo(dateStr: string): number {
  const d = dateStr.includes('T') ? new Date(dateStr) : new Date(dateStr + 'T00:00:00');
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24)));
}

interface Client {
  name: string;
  clientId?: string;
  totalAchats: number;
  totalCredit: number;
  nbCommandes: number;
  lastSaleDate: string;
  oldestDebtDate: string;
  daysOldestDebt: number;
}

type FilterType = 'tous' | 'doivent' | 'actifs';

const FILTERS: { key: FilterType; label: string }[] = [
  { key: 'tous', label: 'Tous' },
  { key: 'doivent', label: 'En dette' },
  { key: 'actifs', label: 'Actifs' },
];

function avatarColor(name: string): string {
  return AVATAR_PALETTE[(name.charCodeAt(0) || 0) % AVATAR_PALETTE.length];
}

export default function ClientsScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const session = useAuthStore(s => s.session);
  const businessId = session?.activeBusiness?.id ?? '';
  const userId = session?.user.id ?? '';
  const currency = session?.activeBusiness?.currency ?? 'GNF';
  const role = session?.activeMembership?.role;
  const isVendeur = role === 'vendeur';
  const isInvestisseur = role === 'investisseur';

  const { filter: filterParam } = useLocalSearchParams<{ filter?: FilterType }>();
  const { sales, loading, error, offline, offlineSince, fetchSales } = useVentesStore();
  // "En dette" is the default — this screen's job is collection, not a plain
  // directory. An explicit ?filter= param (including 'tous') is still honored.
  const [filter, setFilter] = useState<FilterType>(
    filterParam === 'tous' || filterParam === 'doivent' || filterParam === 'actifs' ? filterParam : 'doivent',
  );
  const [search, setSearch] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  useFocusEffect(
    useCallback(() => {
      if (businessId) fetchSales(businessId, isVendeur ? userId : undefined);
    }, [businessId]),
  );

  const onRefresh = useCallback(async () => {
    if (!businessId) return;
    setRefreshing(true);
    await fetchSales(businessId, isVendeur ? userId : undefined);
    setRefreshing(false);
  }, [businessId, isVendeur, userId]);

  const sendWhatsAppReminder = (client: Client) => {
    const msg = buildDebtReminderMessage(client.name, fmt(client.totalCredit, currency));
    Linking.openURL(`https://wa.me/?text=${encodeURIComponent(msg)}`).catch(() => {});
  };

  const allClients = useMemo<Client[]>(() => {
    const map = new Map<string, Client>();
    for (const s of sales) {
      const name = s.customer_name?.trim();
      if (!name) continue;
      // Key by client_id when available — prevents two "Mamadou"s from merging
      const key = s.client_id ?? name;
      const existing = map.get(key) ?? {
        name, clientId: s.client_id ?? undefined, totalAchats: 0, totalCredit: 0, nbCommandes: 0,
        lastSaleDate: '', oldestDebtDate: '', daysOldestDebt: 0,
      };
      if (s.status !== 'annule') {
        existing.totalAchats += s.total_amount - (s.discount_amount ?? 0);
        const sDate = s.sale_date ?? s.created_at.split('T')[0];
        if (!existing.lastSaleDate || sDate > existing.lastSaleDate) {
          existing.lastSaleDate = sDate;
        }
      }
      if (s.status === 'credit') {
        const remaining = s.total_amount - (s.discount_amount ?? 0) - (s.amount_paid ?? 0);
        if (remaining > 0.01) {
          existing.totalCredit += remaining;
          const saleDate = s.sale_date ?? s.created_at.split('T')[0];
          if (!existing.oldestDebtDate || saleDate < existing.oldestDebtDate) {
            existing.oldestDebtDate = saleDate;
            existing.daysOldestDebt = getDaysAgo(saleDate);
          }
        }
      }
      existing.nbCommandes += 1;
      map.set(key, existing);
    }
    return Array.from(map.values()).sort((a, b) => b.totalCredit - a.totalCredit || b.totalAchats - a.totalAchats);
  }, [sales]);

  const displayedClients = useMemo<Client[]>(() => {
    let list = allClients;
    if (filter === 'doivent') {
      list = list.filter(c => c.totalCredit > 0)
        .sort((a, b) => b.daysOldestDebt - a.daysOldestDebt || b.totalCredit - a.totalCredit);
    }
    if (filter === 'actifs') list = [...list].sort((a, b) => b.lastSaleDate.localeCompare(a.lastSaleDate));
    const q = search.trim().toLowerCase();
    if (q) list = list.filter(c => c.name.toLowerCase().includes(q));
    return list;
  }, [allClients, filter, search]);

  // Search is shown once the full client list is big enough to need it —
  // keyed on allClients, not the filter-narrowed displayedClients, since
  // the filter chips just reorder/narrow one list, not switch between two.
  const searchVisible = allClients.length >= SEARCH_VISIBILITY_THRESHOLD;
  useAnimateLayoutChange(searchVisible);
  useEffect(() => {
    if (!searchVisible) setSearch('');
  }, [searchVisible]);

  const totalOwedClients = allClients.filter(c => c.totalCredit > 0).length;
  const totalOwedAmount = allClients.reduce((s, c) => s + c.totalCredit, 0);

  return (
    <Screen>
      <View style={styles.hdr}>
        <Pressable onPress={() => router.back()}><Text variant="body" color="secondary">‹ Retour</Text></Pressable>
        <Text variant="h4">{isVendeur ? 'Mes clients' : 'Clients'}</Text>
        <View style={{ width: 60 }} />
      </View>

      {/* Leads with the total — this is the number she opens the screen to
          see. Own banner, not a small nav-bar subtitle, so it reads as the
          screen's actual headline. */}
      {allClients.length > 0 && (
        <View style={styles.totalBanner}>
          {totalOwedAmount > 0 ? (
            <>
              {/* Plain, calm foreground — never red. These are her own
                  receivables, not a loss; color here is reserved for AGE
                  (how overdue), not for the existence of a debt itself. */}
              <Text style={{ color: palette.textPrimary, fontFamily: fontFamily.bold, fontSize: 20, lineHeight: 25 }}>
                On vous doit {fmt(totalOwedAmount, currency)} au total
              </Text>
              <Text variant="caption" color="secondary">
                {totalOwedClients} client{totalOwedClients > 1 ? 's' : ''} en dette
              </Text>
            </>
          ) : (
            <>
              <Text style={{ color: palette.recouvrementPaid, fontFamily: fontFamily.bold, fontSize: 20, lineHeight: 25 }}>
                Tout est réglé ✓
              </Text>
              <Text variant="caption" color="secondary">
                {allClients.length} client{allClients.length > 1 ? 's' : ''}
              </Text>
            </>
          )}
        </View>
      )}

      {/* Filter chips — "En dette" carries the one small red signal on this
          screen (a real, at-a-glance "there's work here" marker), independent
          of whether it's the active chip. */}
      <View style={styles.filterRow}>
        {FILTERS.map(f => (
          <Pressable key={f.key} onPress={() => setFilter(f.key)}
            style={[styles.filterChip, filter === f.key && styles.filterChipActive]}>
            <Text variant="caption" style={{ color: filter === f.key ? palette.textInverse : palette.textSecondary }}>
              {f.label}
            </Text>
            {f.key === 'doivent' && totalOwedClients > 0 && (
              <View style={[styles.filterBadge, { backgroundColor: palette.recouvrementOwed }]}>
                {/* Explicit lineHeight == fontSize — without it the custom
                    font's default line box sits taller than the glyph and
                    the digit renders off-center inside this small circle. */}
                <Text style={{ color: palette.textInverse, fontSize: 10, lineHeight: 10, fontFamily: fontFamily.bold }}>
                  {totalOwedClients}
                </Text>
              </View>
            )}
          </Pressable>
        ))}
      </View>

      {searchVisible && (
        <View style={styles.searchRow}>
          <Input placeholder="Rechercher un client…" value={search} onChangeText={setSearch} />
        </View>
      )}

      {offline && (
        <OfflineNotice
          offlineSince={offlineSince}
          onRetry={() => fetchSales(businessId, isVendeur ? userId : undefined)}
        />
      )}

      {loading && allClients.length === 0 ? (
        <SkeletonList count={6} />
      ) : !loading && allClients.length === 0 && error ? (
        <View style={styles.empty}>
          <Text variant="body" color="secondary" style={{ textAlign: 'center' }}>Données non disponibles hors ligne</Text>
        </View>
      ) : displayedClients.length === 0 ? (
        search.trim() ? (
          <NoResultsState
            query={search}
            createLabel={isInvestisseur ? undefined : `+ Nouveau client « ${search.trim()} »`}
            onCreate={isInvestisseur ? undefined : () => router.push({
              pathname: '/(app)/(tabs)/vendre',
              params: { mode: 'credit', newClientName: search.trim() },
            })}
          />
        ) : filter === 'doivent' ? (
          // Neutral here, deliberately — the header above already carries
          // the one "Tout est réglé ✓" green moment for this exact state;
          // repeating it here would put two green elements on screen at once.
          <View style={styles.empty}>
            <View style={[styles.emptyIconWrap, { backgroundColor: palette.border + '55' }]}>
              <Ionicons name="checkmark-circle-outline" size={32} color={palette.textSecondary} />
            </View>
            <Text variant="h4" style={styles.emptyTitle}>Aucune dette</Text>
            <Text variant="body" color="secondary" style={styles.emptyHint}>Aucun client ne vous doit.</Text>
          </View>
        ) : (
          <View style={styles.empty}>
            <View style={[styles.emptyIconWrap, { backgroundColor: palette.primaryLight }]}>
              <Ionicons name="people-outline" size={32} color={palette.primary} />
            </View>
            <Text variant="h4" style={styles.emptyTitle}>
              {isVendeur ? 'Vos clients arrivent' : 'Personne encore'}
            </Text>
            <Text variant="body" color="secondary" style={styles.emptyHint}>
              {isVendeur ? 'Faites votre première vente.' : 'Chaque vente crée un client.'}
            </Text>
          </View>
        )
      ) : (
        <FlatList
          data={displayedClients}
          keyExtractor={c => c.clientId ?? c.name}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.primary} colors={[palette.primary]} />
          }
          renderItem={({ item }) => (
            <Pressable
              onPress={() => router.push(`/clients/${encodeURIComponent(item.clientId ?? item.name)}`)}
              style={({ pressed }) => [styles.clientRow, pressed && { opacity: 0.75 }]}>
              <View style={[styles.avatar, { backgroundColor: avatarColor(item.name) + '20' }]}>
                <Text variant="label" allowFontScaling={false} style={{ color: avatarColor(item.name) }}>
                  {item.name[0]?.toUpperCase()}
                </Text>
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="label">{item.name}</Text>
                {item.totalCredit > 0 && (
                  <Text variant="caption" style={{ color: debtAgeColor(item.daysOldestDebt, palette) }}>
                    {formatDebtAge(item.daysOldestDebt)}
                  </Text>
                )}
              </View>
              {item.totalCredit > 0 ? (
                <View style={{ alignItems: 'flex-end', gap: 6 }}>
                  {/* Plain, calm — not red. Color on this row lives entirely
                      on the age caption above, not on the amount. */}
                  <Text variant="label" style={{ color: palette.textPrimary, fontFamily: fontFamily.bold }}>
                    Vous doit {fmt(item.totalCredit, currency)}
                  </Text>
                  {!isInvestisseur && (
                    <Pressable
                      onPress={() => sendWhatsAppReminder(item)}
                      hitSlop={8}
                      style={({ pressed }) => [styles.waBtn, { opacity: pressed ? 0.6 : 1 }]}
                    >
                      <Ionicons name="logo-whatsapp" size={14} color={palette.primary} />
                      <Text variant="caption" style={styles.waBtnText}>Rappeler</Text>
                    </Pressable>
                  )}
                </View>
              ) : (
                // Neutral — green is reserved for the one "Tout est réglé ✓"
                // header moment, not sprinkled on every settled row too.
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' }}>
                  <Text variant="caption" color="secondary" style={{ marginRight: 8 }}>Réglé</Text>
                  <Text variant="caption" color="secondary">›</Text>
                </View>
              )}
            </Pressable>
          )}
          ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: palette.border }} />}
        />
      )}

      {/* A real client isn't created here directly (see the empty state's own
          copy — "Chaque vente crée un client"), so this FAB is a shortcut
          into the one place that does create one: Vendre's credit flow,
          fresh (no prefilled name), for whoever's already looking at this
          list and wants to log a new debtor without leaving it. Hidden
          while the list is empty, same as every other screen's FAB. */}
      {allClients.length > 0 && !isInvestisseur && (
        <View style={styles.fabContainer}>
          <Pressable
            onPress={() => router.push({ pathname: '/(app)/(tabs)/vendre', params: { mode: 'credit' } })}
            style={({ pressed }) => [styles.fabExtended, pressed && { opacity: 0.82 }]}
            accessibilityLabel="Nouveau client"
            accessibilityRole="button"
          >
            <Ionicons name="add" size={20} color={palette.textInverse} />
            <Text style={styles.fabExtendedLabel}>Client</Text>
          </Pressable>
        </View>
      )}
    </Screen>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: p.background },
    hdr: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      padding: spacing[5], borderBottomWidth: 1, borderBottomColor: p.border,
    },
    totalBanner: {
      paddingHorizontal: spacing[5], paddingTop: spacing[4], paddingBottom: spacing[2], gap: 2,
    },
    filterRow: {
      flexDirection: 'row', justifyContent: 'center', paddingHorizontal: spacing[5], paddingVertical: spacing[3], gap: spacing[2],
    },
    searchRow: { paddingHorizontal: spacing[5], paddingBottom: spacing[2] },
    filterChip: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[1],
      paddingHorizontal: spacing[3], paddingVertical: spacing[1.5],
      borderRadius: radius.full, borderWidth: 1, borderColor: p.border, backgroundColor: p.surface,
    },
    filterChipActive: { backgroundColor: p.primary, borderColor: p.primary },
    filterBadge: {
      minWidth: 16, height: 16, borderRadius: 8, paddingHorizontal: 3,
      alignItems: 'center', justifyContent: 'center',
    },
    list: { paddingBottom: spacing[10] },
    clientRow: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing[3],
      paddingHorizontal: spacing[5], paddingVertical: spacing[3], backgroundColor: p.surface,
    },
    avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing[8] },
    emptyIconWrap: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', marginBottom: spacing[4] },
    emptyTitle: { textAlign: 'center' as const, marginBottom: spacing[2] },
    emptyHint: { textAlign: 'center' as const },
    center: { textAlign: 'center', marginTop: spacing[10] },
    waBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 4,
      paddingHorizontal: spacing[2], paddingVertical: 3,
      borderRadius: radius.sm, borderWidth: 1, borderColor: p.primary + '40',
      backgroundColor: p.primary + '12',
    },
    waBtnText: { color: p.primary, fontSize: 11 },
    fabContainer: { position: 'absolute', bottom: 24, right: spacing[4], zIndex: 10 },
    fabExtended: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[2],
      height: 56, paddingHorizontal: spacing[5], borderRadius: radius.full,
      backgroundColor: p.primary,
      shadowColor: p.textPrimary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.18, shadowRadius: 8, elevation: 8,
    },
    fabExtendedLabel: { fontFamily: fontFamily.semibold, fontSize: 15, color: p.textInverse },
  });
}
