import { useCallback, useMemo, useState } from 'react';
import { FlatList, Linking, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { Screen } from '@/src/components/ui/Screen';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/src/components/ui/Text';
import { Input } from '@/src/components/ui/Input';
import { useTheme, spacing, radius, AVATAR_PALETTE } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useVentesStore } from '@/stores/ventes';
import { OfflineNotice } from '@/src/components/ui/OfflineNotice';
import { SkeletonList } from '@/src/components/ui/SkeletonPlaceholder';

function fmt(n: number, cur: string) { return `${Math.round(n).toLocaleString('fr-FR')} ${cur}`; }

function getDaysAgo(dateStr: string): number {
  const d = dateStr.includes('T') ? new Date(dateStr) : new Date(dateStr + 'T00:00:00');
  return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
}

function fmtDue(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  const diff = Math.round((d.getTime() - Date.now()) / 86400000);
  if (diff < 0) return `En retard de ${Math.abs(diff)} j`;
  if (diff === 0) return "Prévu aujourd'hui";
  if (diff <= 3) return `Dans ${diff} jour${diff > 1 ? 's' : ''}`;
  return `Prévu le ${d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}`;
}

interface Client {
  name: string;
  clientId?: string;
  totalAchats: number;
  totalCredit: number;
  nbCommandes: number;
  lastSaleDate: string;
  sellers: string[];
  oldestDebtDate: string;
  daysOldestDebt: number;
  nearestDueDate: string | null;
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
  const [filter, setFilter] = useState<FilterType>(filterParam === 'doivent' || filterParam === 'actifs' ? filterParam : 'tous');
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
    const msg = [
      `Salut ${client.name},`,
      `Un petit point sur le carnet : il vous reste un solde de *${fmt(client.totalCredit, currency)}*.`,
      `Vous pouvez passer à la boutique ou effectuer un dépôt directement.`,
      `Bonne journée à vous !`,
    ].join('\n');
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
        lastSaleDate: '', sellers: [], oldestDebtDate: '', daysOldestDebt: 0, nearestDueDate: null,
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
          const dd = s.due_date ?? null;
          if (dd && (!existing.nearestDueDate || dd < existing.nearestDueDate)) {
            existing.nearestDueDate = dd;
          }
        }
      }
      existing.nbCommandes += 1;
      if (s.seller_name && !existing.sellers.includes(s.seller_name)) {
        existing.sellers.push(s.seller_name);
      }
      map.set(key, existing);
    }
    return Array.from(map.values()).sort((a, b) => b.totalCredit - a.totalCredit || b.totalAchats - a.totalAchats);
  }, [sales]);

  const displayedClients = useMemo<Client[]>(() => {
    let list = allClients;
    if (filter === 'doivent') {
      list = list.filter(c => c.totalCredit > 0).sort((a, b) => b.daysOldestDebt - a.daysOldestDebt);
    }
    if (filter === 'actifs') list = [...list].sort((a, b) => b.lastSaleDate.localeCompare(a.lastSaleDate));
    const q = search.trim().toLowerCase();
    if (q) list = list.filter(c => c.name.toLowerCase().includes(q));
    return list;
  }, [allClients, filter, search]);

  const totalOwedClients = allClients.filter(c => c.totalCredit > 0).length;
  const totalOwedAmount = allClients.reduce((s, c) => s + c.totalCredit, 0);

  const headerSubtitle =
    allClients.length === 0 ? '' :
    `${allClients.length} client${allClients.length > 1 ? 's' : ''}` +
    (totalOwedAmount > 0
      ? ` · ${totalOwedClients} doi${totalOwedClients > 1 ? 'vent' : 't'} ${fmt(totalOwedAmount, currency)}`
      : '');

  return (
    <Screen>
      <View style={styles.hdr}>
        <Pressable onPress={() => router.back()}><Text variant="body" color="secondary">‹ Retour</Text></Pressable>
        <View style={{ alignItems: 'center' }}>
          <Text variant="h4">{isVendeur ? 'Mes clients' : 'Clients'}</Text>
          {headerSubtitle ? <Text variant="caption" color="secondary">{headerSubtitle}</Text> : null}
        </View>
        <View style={{ width: 60 }} />
      </View>

      {/* Filter chips */}
      <View style={styles.filterRow}>
        {FILTERS.map(f => (
          <Pressable key={f.key} onPress={() => setFilter(f.key)}
            style={[styles.filterChip, filter === f.key && styles.filterChipActive]}>
            <Text variant="caption" style={{ color: filter === f.key ? palette.textInverse : palette.textSecondary }}>
              {f.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {allClients.length >= 15 && (
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
          <View style={styles.empty}>
            <Ionicons name="search-outline" size={40} color={palette.textDisabled} />
            <Text variant="body" color="secondary" style={[styles.emptyHint, { marginTop: spacing[3] }]}>
              Aucun résultat pour "{search}"
            </Text>
          </View>
        ) : filter === 'doivent' ? (
          <View style={styles.empty}>
            <View style={[styles.emptyIconWrap, { backgroundColor: palette.successLight }]}>
              <Ionicons name="checkmark-circle" size={32} color={palette.success} />
            </View>
            <Text variant="h4" style={styles.emptyTitle}>Tout est à jour</Text>
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
                {item.totalCredit > 0 && item.nearestDueDate && (
                  <Text variant="caption" style={{
                    color: new Date(item.nearestDueDate + 'T00:00:00') < new Date() ? palette.warning : palette.textSecondary,
                  }}>
                    {fmtDue(item.nearestDueDate)}
                  </Text>
                )}
                {!isVendeur && item.sellers.length > 0 && (
                  <Text variant="caption" color="secondary">
                    Vendeur: {item.sellers.join(', ')}
                  </Text>
                )}
              </View>
              {item.totalCredit > 0 ? (
                <View style={{ alignItems: 'flex-end', gap: 6 }}>
                  <Text variant="label" style={{ color: palette.warning }}>{fmt(item.totalCredit, currency)}</Text>
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
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' }}>
                  <Text variant="caption" style={{ color: palette.success, fontWeight: '600', marginRight: 8 }}>À jour</Text>
                  <Text variant="caption" color="secondary">›</Text>
                </View>
              )}
            </Pressable>
          )}
          ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: palette.border }} />}
        />
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
    filterRow: {
      flexDirection: 'row', justifyContent: 'center', paddingHorizontal: spacing[5], paddingVertical: spacing[3], gap: spacing[2],
    },
    searchRow: { paddingHorizontal: spacing[5], paddingBottom: spacing[2] },
    filterChip: {
      paddingHorizontal: spacing[3], paddingVertical: spacing[1.5],
      borderRadius: radius.full, borderWidth: 1, borderColor: p.border, backgroundColor: p.surface,
    },
    filterChipActive: { backgroundColor: p.primary, borderColor: p.primary },
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
  });
}
