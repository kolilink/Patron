import { useCallback, useEffect, useMemo } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useFocusEffect } from 'expo-router';
import { Card } from '@/src/components/ui/Card';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing, colors, radius } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useVentesStore } from '@/stores/ventes';
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

interface DebtorClient {
  name: string;
  totalOwed: number;
  nbSales: number;
  oldestDate: string;
  daysOldest: number;
  sellers: string[];
  nearestDueDate: string | null;
}

export default function CreditsScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const session = useAuthStore(s => s.session);
  const businessId = session?.activeBusiness?.id ?? '';
  const userId = session?.user.id ?? '';
  const currency = session?.activeBusiness?.currency ?? 'GNF';
  const role = session?.activeMembership?.role;
  const isVendeur = role === 'vendeur';

  const { sales, loading, error, fetchSales } = useVentesStore();

  useFocusEffect(
    useCallback(() => {
      if (businessId) fetchSales(businessId, isVendeur ? userId : undefined);
    }, [businessId, isVendeur, userId]),
  );

  const debtors = useMemo<DebtorClient[]>(() => {
    const map = new Map<string, DebtorClient>();

    for (const s of sales) {
      if (s.status !== 'credit') continue;
      const name = s.customer_name?.trim() || 'Client inconnu';
      const remaining = s.total_amount - (s.discount_amount ?? 0) - (s.amount_paid ?? 0);
      if (remaining < 0.01) continue;

      const saleDate = s.sale_date ?? s.created_at.split('T')[0];
      const existing = map.get(name);
      if (existing) {
        existing.totalOwed += remaining;
        existing.nbSales += 1;
        if (saleDate < existing.oldestDate) {
          existing.oldestDate = saleDate;
          existing.daysOldest = getDaysAgo(saleDate);
        }
        if (s.seller_name && !existing.sellers.includes(s.seller_name)) {
          existing.sellers.push(s.seller_name);
        }
        const dd = s.due_date ?? null;
        if (dd && (!existing.nearestDueDate || dd < existing.nearestDueDate)) {
          existing.nearestDueDate = dd;
        }
      } else {
        map.set(name, {
          name,
          totalOwed: remaining,
          nbSales: 1,
          oldestDate: saleDate,
          daysOldest: getDaysAgo(saleDate),
          sellers: s.seller_name ? [s.seller_name] : [],
          nearestDueDate: s.due_date ?? null,
        });
      }
    }

    // Sort: oldest debt first (most urgent)
    return Array.from(map.values()).sort((a, b) => b.daysOldest - a.daysOldest);
  }, [sales]);

  const totalOutstanding = debtors.reduce((s, c) => s + c.totalOwed, 0);

  const navToLedger = (name: string) =>
    router.push(`/clients/${encodeURIComponent(name)}`);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()}><Text variant="body" color="secondary">‹ Retour</Text></Pressable>
        <Text variant="h4">Clients qui vous doivent</Text>
        <View style={{ width: 60 }} />
      </View>

      {/* Total outstanding — hidden when nothing is owed */}
      {debtors.length > 0 && <Card style={styles.totalCard}>
        <Text variant="caption" color="secondary">Crédit total</Text>
        <Text variant="amountLarge" style={{ color: debtors.length > 0 ? palette.warning : palette.textPrimary }}>
          {fmt(totalOutstanding, currency)}
        </Text>
        <Text variant="caption" color="secondary">
          {debtors.length} client{debtors.length !== 1 ? 's' : ''} vous {debtors.length !== 1 ? 'doivent' : 'doit'} de l'argent
        </Text>
      </Card>}

      {loading && debtors.length === 0 ? (
        <SkeletonList count={5} />
      ) : !loading && debtors.length === 0 && error ? (
        <View style={styles.empty}>
          <Text variant="body" color="secondary" style={{ textAlign: 'center' }}>
            Données non disponibles
          </Text>
          <Pressable
            onPress={() => fetchSales(businessId, isVendeur ? userId : undefined)}
            style={{ marginTop: spacing[4] }}
          >
            <Text variant="label" style={{ color: palette.primary }}>Réessayer</Text>
          </Pressable>
        </View>
      ) : debtors.length === 0 ? (
        <View style={styles.empty}>
          <View style={styles.emptyBadge}>
            <Ionicons name="checkmark-circle" size={36} color={palette.success} />
          </View>
          <Text variant="h4" style={{ textAlign: 'center', marginBottom: spacing[2] }}>Comptes soldés</Text>
          <Text variant="body" color="secondary" style={{ textAlign: 'center' }}>
            Des gens vous doivent de l'argent ?{'\n'}Notez-le ici — sans créer de produits.
          </Text>
          <Pressable
            onPress={() => router.push('/(app)/onboarding/carnet')}
            style={({ pressed }) => [styles.carnetCta, { opacity: pressed ? 0.7 : 1, borderColor: palette.primary }]}
          >
            <Text variant="label" style={{ color: palette.primary }}>Ajouter une dette</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={debtors}
          keyExtractor={c => c.name}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => {
            const urgent = item.daysOldest >= 7;
            return (
              <Pressable onPress={() => navToLedger(item.name)}
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.75 }]}>
                <View style={[styles.avatar, { backgroundColor: urgent ? colors.danger[50] : colors.warning[50] }]}>
                  <Text variant="label" style={{ color: urgent ? palette.danger : palette.warning }}>
                    {item.name[0]?.toUpperCase()}
                  </Text>
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[1] }}>
                    {urgent && <Text variant="caption" style={{ color: palette.danger }}>⚠️</Text>}
                    <Text variant="label" numberOfLines={1}>{item.name}</Text>
                  </View>
                  <Text variant="caption" color="secondary">
                    {item.nbSales} vente{item.nbSales > 1 ? 's' : ''} à crédit
                    {' · '}
                    {item.daysOldest === 0 ? "aujourd'hui" : `il y a ${item.daysOldest} j`}
                  </Text>
                  {item.nearestDueDate && (
                    <Text variant="caption" style={{
                      color: new Date(item.nearestDueDate + 'T00:00:00') < new Date() ? palette.warning : palette.textSecondary,
                    }}>
                      {fmtDue(item.nearestDueDate)}
                    </Text>
                  )}
                  {!isVendeur && item.sellers.length > 0 && (
                    <Text variant="caption" color="secondary">
                      {item.sellers.join(', ')} à fait cette vente
                    </Text>
                  )}
                </View>
                <View style={{ alignItems: 'flex-end', gap: 2 }}>
                  <Text variant="label" style={{ color: palette.warning }}>{fmt(item.totalOwed, currency)}</Text>
                  <Text variant="caption" color="secondary">›</Text>
                </View>
              </Pressable>
            );
          }}
          ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: palette.border }} />}
        />
      )}
    </SafeAreaView>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
  safe: { flex: 1, backgroundColor: p.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing[5], paddingVertical: spacing[4],
    borderBottomWidth: 1, borderBottomColor: p.border,
  },
  totalCard: {
    marginHorizontal: spacing[5], marginVertical: spacing[4],
    alignItems: 'center', gap: spacing[1],
    borderColor: p.warning + '40', borderWidth: 1,
  },
  list: { paddingBottom: spacing[10] },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: spacing[3],
    paddingHorizontal: spacing[5], paddingVertical: spacing[3],
    backgroundColor: p.surface,
  },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing[8] },
  emptyBadge: { width: 88, height: 88, borderRadius: 44, backgroundColor: p.successLight, alignItems: 'center', justifyContent: 'center', marginBottom: spacing[5] },
  carnetCta: {
    marginTop: spacing[4],
    paddingVertical: spacing[3], paddingHorizontal: spacing[6],
    borderWidth: 1, borderRadius: radius.md,
  },
  center: { textAlign: 'center', marginTop: spacing[10] },
  });
}
