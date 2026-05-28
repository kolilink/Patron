import { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useFocusEffect } from 'expo-router';
import { Text } from '@/src/components/ui/Text';
import { palette, spacing, colors, radius } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useVentesStore } from '@/stores/ventes';

function fmt(n: number, cur: string) { return `${Math.round(n).toLocaleString('fr-FR')} ${cur}`; }

function fmtDate(iso: string) {
  const d = iso.includes('T') ? new Date(iso) : new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

interface Client {
  name: string;
  totalAchats: number;
  totalCredit: number;
  nbCommandes: number;
  lastSaleDate: string;
  sellers: string[];
}

type FilterType = 'tous' | 'doivent' | 'recents';

const FILTERS: { key: FilterType; label: string }[] = [
  { key: 'tous', label: 'Tous' },
  { key: 'doivent', label: 'Doivent' },
  { key: 'recents', label: 'Récents' },
];

export default function ClientsScreen() {
  const session = useAuthStore(s => s.session);
  const businessId = session?.activeBusiness?.id ?? '';
  const userId = session?.user.id ?? '';
  const currency = session?.activeBusiness?.currency ?? 'GNF';
  const role = session?.activeMembership?.role;
  const isVendeur = role === 'vendeur';

  const { sales, loading, fetchSales } = useVentesStore();
  const [filter, setFilter] = useState<FilterType>('tous');

  useFocusEffect(
    useCallback(() => {
      if (businessId) fetchSales(businessId, isVendeur ? userId : undefined);
    }, [businessId]),
  );

  const allClients = useMemo<Client[]>(() => {
    const map = new Map<string, Client>();
    for (const s of sales) {
      const name = s.customer_name?.trim();
      if (!name) continue; // skip anonymous / walk-in sales
      const existing = map.get(name) ?? { name, totalAchats: 0, totalCredit: 0, nbCommandes: 0, lastSaleDate: '', sellers: [] };
      if (s.status !== 'annule') {
        existing.totalAchats += s.total_amount;
        const sDate = s.sale_date ?? s.created_at.split('T')[0];
        if (!existing.lastSaleDate || sDate > existing.lastSaleDate) {
          existing.lastSaleDate = sDate;
        }
      }
      if (s.status === 'credit') {
        const remaining = s.total_amount - (s.amount_paid ?? 0);
        if (remaining > 0.01) existing.totalCredit += remaining;
      }
      existing.nbCommandes += 1;
      if (s.seller_name && !existing.sellers.includes(s.seller_name)) {
        existing.sellers.push(s.seller_name);
      }
      map.set(name, existing);
    }
    return Array.from(map.values()).sort((a, b) => b.totalCredit - a.totalCredit || b.totalAchats - a.totalAchats);
  }, [sales]);

  const displayedClients = useMemo<Client[]>(() => {
    if (filter === 'doivent') return allClients.filter(c => c.totalCredit > 0);
    if (filter === 'recents') return [...allClients].sort((a, b) => b.lastSaleDate.localeCompare(a.lastSaleDate));
    return allClients;
  }, [allClients, filter]);

  const totalOwedClients = allClients.filter(c => c.totalCredit > 0).length;
  const totalOwedAmount = allClients.reduce((s, c) => s + c.totalCredit, 0);

  const headerSubtitle =
    allClients.length === 0 ? '' :
    `${allClients.length} client${allClients.length > 1 ? 's' : ''}` +
    (totalOwedAmount > 0
      ? ` · ${totalOwedClients} doi${totalOwedClients > 1 ? 'vent' : 't'} ${fmt(totalOwedAmount, currency)}`
      : '');

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
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

      {loading && allClients.length === 0 ? (
        <Text variant="body" color="secondary" style={styles.center}>Chargement…</Text>
      ) : displayedClients.length === 0 ? (
        <View style={styles.empty}>
          <Text variant="body" color="secondary">
            {filter === 'doivent'
              ? 'Aucun client ne doit en ce moment.'
              : isVendeur ? 'Aucun client enregistré sur vos ventes.' : 'Aucun client enregistré.'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={displayedClients}
          keyExtractor={c => c.name}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => router.push(`/clients/${encodeURIComponent(item.name)}`)}
              style={({ pressed }) => [styles.clientRow, pressed && { opacity: 0.75 }]}>
              <View style={[styles.avatar, { backgroundColor: item.totalCredit > 0 ? colors.warning[50] : palette.primaryLight }]}>
                <Text variant="label" style={{ color: item.totalCredit > 0 ? palette.warning : palette.primary }}>
                  {item.name[0]?.toUpperCase()}
                </Text>
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="label">{item.name}</Text>
                {item.totalCredit > 0 ? (
                  <Text variant="caption" style={{ color: palette.warning }}>
                    Doit {fmt(item.totalCredit, currency)}
                  </Text>
                ) : (
                  <Text variant="caption" color="secondary">
                    {item.nbCommandes} achat{item.nbCommandes > 1 ? 's' : ''}
                    {item.lastSaleDate ? ` · ${fmtDate(item.lastSaleDate)}` : ''}
                  </Text>
                )}
                {!isVendeur && item.sellers.length > 0 && (
                  <Text variant="caption" color="secondary">
                    Vendeur: {item.sellers.join(', ')}
                  </Text>
                )}
              </View>
              <Text variant="caption" color="secondary">›</Text>
            </Pressable>
          )}
          ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: palette.border }} />}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.background },
  hdr: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    padding: spacing[5], borderBottomWidth: 1, borderBottomColor: palette.border,
  },
  filterRow: {
    flexDirection: 'row', paddingHorizontal: spacing[5], paddingVertical: spacing[3], gap: spacing[2],
  },
  filterChip: {
    paddingHorizontal: spacing[3], paddingVertical: spacing[1.5],
    borderRadius: radius.full, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface,
  },
  filterChipActive: { backgroundColor: palette.primary, borderColor: palette.primary },
  list: { paddingBottom: spacing[10] },
  clientRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing[3],
    paddingHorizontal: spacing[5], paddingVertical: spacing[3], backgroundColor: palette.surface,
  },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  center: { textAlign: 'center', marginTop: spacing[10] },
});
