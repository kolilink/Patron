import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Linking, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { Screen } from '@/src/components/ui/Screen';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/src/components/ui/Text';
import { Input } from '@/src/components/ui/Input';
import { NoResultsState } from '@/src/components/ui/NoResultsState';
import { EmptyState } from '@/src/components/ui/EmptyState';
import { useTheme, spacing, radius, fontFamily, AVATAR_PALETTE, SEARCH_VISIBILITY_THRESHOLD } from '@/src/theme';
import { useAnimateLayoutChange } from '@/src/hooks/useAnimateLayoutChange';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useVentesStore } from '@/stores/ventes';
import { supabase } from '@/lib/supabase';
import { OfflineNotice } from '@/src/components/ui/OfflineNotice';
import { SkeletonList } from '@/src/components/ui/SkeletonPlaceholder';
import { buildDebtReminderMessage, formatDebtAge, debtAgeTier } from '@/src/utils/clientReminder';
import { formatAmount } from '@/src/utils/format';

function fmt(n: number, cur: string) { return formatAmount(n, cur); }

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

// Canonical client names from the clients table — a client created through the
// carnet ("+ Crédit") has a row there, and its name is the source of truth the
// detail screen already uses. The list must use the same name so the two
// "Rappeler" WhatsApp drafts can never disagree.
interface ClientNames {
  byId: Record<string, string>;
  byName: Record<string, string>;
}

type FilterType = 'tous' | 'doivent' | 'actifs';

const FILTERS: { key: FilterType; label: string }[] = [
  { key: 'tous', label: 'Tous' },
  { key: 'doivent', label: 'En dette' },
  { key: 'actifs', label: 'Récents' },
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
  const [clientNames, setClientNames] = useState<ClientNames>({ byId: {}, byName: {} });

  useFocusEffect(
    useCallback(() => {
      if (businessId) fetchSales(businessId, isVendeur ? userId : undefined);
    }, [businessId]),
  );

  // Load canonical names from the clients table (best-effort, never blocks
  // the list — fallback is the sale's own customer_name).
  useEffect(() => {
    if (!businessId) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('clients')
        .select('id, name')
        .eq('business_id', businessId);
      if (error || cancelled) return;
      const byId: Record<string, string> = {};
      const byName: Record<string, string> = {};
      for (const r of (data ?? []) as { id: string; name: string }[]) {
        byId[r.id] = r.name;
        byName[r.name] = r.name;
      }
      setClientNames({ byId, byName });
    })();
    return () => { cancelled = true; };
  }, [businessId]);

  const onRefresh = useCallback(async () => {
    if (!businessId) return;
    setRefreshing(true);
    await fetchSales(businessId, isVendeur ? userId : undefined);
    setRefreshing(false);
  }, [businessId, isVendeur, userId]);

  const sendWhatsAppReminder = (client: Client) => {
    const msg = buildDebtReminderMessage(client.name, fmt(client.totalCredit, currency));
    Linking.openURL(`https://wa.me/?text=${encodeURIComponent(msg)}`).catch(() => { });
  };

  const allClients = useMemo<Client[]>(() => {
    const map = new Map<string, Client>();
    for (const s of sales) {
      const rawName = s.customer_name?.trim();
      if (!rawName) continue;
      // Canonical name from the clients table (matches the detail screen's
      // displayName), falling back to the sale's own customer_name.
      const name = clientNames.byId[s.client_id as string] ?? clientNames.byName[rawName] ?? rawName;
      // Key by client_id when available — prevents two "Mamadou"s from merging
      const key = s.client_id ?? rawName;
      const existing = map.get(key) ?? {
        name, clientId: s.client_id ?? undefined, totalAchats: 0, totalCredit: 0, nbCommandes: 0,
        lastSaleDate: '', oldestDebtDate: '', daysOldestDebt: 0,
      };
      // Unify with the detail screen's formula: owed = max(0, totalSold −
      // totalPaid) across every non-annulé sale. Previously the list summed
      // only remaining credit lines while the detail summed all sales minus
      // all payments — the two "Rappeler" drafts therefore disagreed.
      if (s.status !== 'annule') {
        existing.totalAchats += s.total_amount - (s.discount_amount ?? 0);
        existing.totalCredit -= s.amount_paid ?? 0;
        const sDate = s.sale_date ?? s.created_at.split('T')[0];
        if (!existing.lastSaleDate || sDate > existing.lastSaleDate) {
          existing.lastSaleDate = sDate;
        }
      }
      if (s.status === 'credit') {
        const saleDate = s.sale_date ?? s.created_at.split('T')[0];
        if (!existing.oldestDebtDate || saleDate < existing.oldestDebtDate) {
          existing.oldestDebtDate = saleDate;
          existing.daysOldestDebt = getDaysAgo(saleDate);
        }
      }
      existing.nbCommandes += 1;
      map.set(key, existing);
    }
    // totalAchats accumulated the owed amount while totalCredit started at 0
    // and subtracted payments — resolve the final clamped owed figure now.
    const out: Client[] = [];
    for (const c of map.values()) {
      c.totalCredit = Math.max(0, c.totalAchats + c.totalCredit);
      out.push(c);
    }
    return out.sort((a, b) => b.totalCredit - a.totalCredit || b.totalAchats - a.totalAchats);
  }, [sales, clientNames]);

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
      {allClients.length > 0 && !(totalOwedAmount === 0 && filter === 'doivent') && (
        <View style={styles.totalBanner}>
          {totalOwedAmount > 0 ? (
            <>
              {/* Plain, calm foreground — never red. These are her own
                  receivables, not a loss; color here is reserved for AGE
                  (how overdue), not for the existence of a debt itself. */}
              <Text style={{ color: palette.textPrimary, fontFamily: fontFamily.bold, fontSize: 20, lineHeight: 25 }}>
                On vous doit {fmt(totalOwedAmount, currency)} au total
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
          <EmptyState
            icon="checkmark-circle-outline"
            title="Aucune dette"
            subtitle="Aucun client ne vous doit."
            actionLabel="Effacer"
            actionVariant="outline"
            onAction={() => setFilter('tous')}
          />
        ) : (
          <EmptyState
            icon="people-outline"
            title={isVendeur ? 'Vos clients arrivent' : 'Personne encore'}
            subtitle={isVendeur ? 'Faites votre première vente.' : 'Chaque vente crée un client.'}
          />
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
