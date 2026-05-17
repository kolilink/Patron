import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Card } from '@/src/components/ui/Card';
import { Text } from '@/src/components/ui/Text';
import { palette, spacing, colors, radius } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useVentesStore } from '@/stores/ventes';
import { useProductStore } from '@/stores/products';

function fmt(n: number, cur: string) { return `${n.toLocaleString('fr-FR')} ${cur}`; }
function pct(n: number) { return n.toFixed(1) + '%'; }

type Period = '7j' | '30j' | '90j';
const PERIOD_DAYS: Record<Period, number> = { '7j': 7, '30j': 30, '90j': 90 };

function Row({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <View style={styles.row}>
      <Text variant="body" style={{ flex: 1 }}>{label}</Text>
      <Text variant="label" style={accent ? { color: accent } : undefined}>{value}</Text>
    </View>
  );
}

export default function RapportsScreen() {
  const session = useAuthStore(s => s.session);
  const businessId = session?.activeBusiness?.id ?? '';
  const userId = session?.user.id ?? '';
  const currency = session?.activeBusiness?.currency ?? 'GNF';

  const { sales, loading, fetchSales } = useVentesStore();
  const { products, fetchProducts } = useProductStore();
  const [period, setPeriod] = useState<Period>('30j');

  useEffect(() => {
    if (!businessId) return;
    fetchSales(businessId);
    fetchProducts(businessId, userId);
  }, [businessId]);

  const cutoff = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - PERIOD_DAYS[period]);
    return d;
  }, [period]);

  const filteredSales = useMemo(
    () => sales.filter(s => s.status === 'paye' && new Date(s.paid_at ?? s.created_at) >= cutoff),
    [sales, cutoff],
  );

  const revenue = filteredSales.reduce((s, v) => s + v.total_amount, 0);
  const creditPending = sales.filter(s => s.status === 'credit').reduce((s, v) => s + v.total_amount, 0);
  const creditCount = sales.filter(s => s.status === 'credit').length;

  // Stock stats
  const stockValue = products.reduce((s, p) => s + p.cost_price * p.stock_qty, 0);
  const stockSaleValue = products.reduce((s, p) => s + p.sale_price * p.stock_qty, 0);
  const potentialMargin = stockSaleValue > 0 ? ((stockSaleValue - stockValue) / stockSaleValue) * 100 : 0;
  const lowStock = products.filter(p => p.stock_qty <= p.reorder_level && p.reorder_level > 0);
  const outOfStock = products.filter(p => p.stock_qty === 0);

  // Top sellers (by seller_name + amount)
  const sellerMap = new Map<string, number>();
  for (const s of filteredSales) {
    sellerMap.set(s.seller_name, (sellerMap.get(s.seller_name) ?? 0) + s.total_amount);
  }
  const topSellers = Array.from(sellerMap.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);

  // Daily revenue for sparkline-style info
  const today = new Date();
  const dailyMap = new Map<string, number>();
  for (let i = 0; i < Math.min(PERIOD_DAYS[period], 7); i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' });
    dailyMap.set(key, 0);
  }
  for (const s of filteredSales) {
    const d = new Date(s.paid_at ?? s.created_at);
    const key = d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' });
    if (dailyMap.has(key)) dailyMap.set(key, (dailyMap.get(key) ?? 0) + s.total_amount);
  }
  const dailyData = Array.from(dailyMap.entries()).reverse();
  const maxDay = Math.max(...dailyData.map(d => d[1]), 1);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.hdr}>
        <Pressable onPress={() => router.back()}><Text variant="body" color="secondary">‹ Retour</Text></Pressable>
        <Text variant="h4">Rapports</Text>
        <View style={{ width: 60 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* Period selector */}
        <View style={styles.periodRow}>
          {(['7j', '30j', '90j'] as Period[]).map(p => (
            <Pressable key={p} onPress={() => setPeriod(p)}
              style={[styles.periodChip, period === p && styles.periodActive]}>
              <Text variant="label" style={{ color: period === p ? palette.textInverse : palette.textSecondary }}>
                {p === '7j' ? '7 jours' : p === '30j' ? '30 jours' : '90 jours'}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* Revenue card */}
        <Card style={styles.revenueCard}>
          <Text variant="caption" color="secondary">Chiffre d'affaires ({period})</Text>
          <Text variant="amountLarge" style={{ color: palette.success }}>{fmt(revenue, currency)}</Text>
          <Text variant="caption" color="secondary">{filteredSales.length} vente{filteredSales.length !== 1 ? 's' : ''} encaissée{filteredSales.length !== 1 ? 's' : ''}</Text>
        </Card>

        {/* Daily bars */}
        {dailyData.length > 0 && (
          <Card style={{ gap: spacing[3] }}>
            <Text variant="label" color="secondary">Ventes par jour (7 derniers jours)</Text>
            <View style={styles.barsRow}>
              {dailyData.map(([label, val]) => (
                <View key={label} style={styles.barWrap}>
                  <View style={[styles.bar, { height: Math.max(4, (val / maxDay) * 80) }]} />
                  <Text variant="caption" color="secondary" style={{ fontSize: 9, textAlign: 'center' }} numberOfLines={1}>{label}</Text>
                </View>
              ))}
            </View>
          </Card>
        )}

        {/* Ventes details */}
        <Card style={{ gap: spacing[3] }}>
          <Text variant="label">Synthèse ventes</Text>
          <Row label="CA encaissé" value={fmt(revenue, currency)} accent={palette.success} />
          <Row label="Créances en attente" value={fmt(creditPending, currency)} accent={creditPending > 0 ? palette.warning : undefined} />
          <Row label="Nb de crédits" value={String(creditCount)} />
          <Row label="Panier moyen" value={filteredSales.length > 0 ? fmt(Math.round(revenue / filteredSales.length), currency) : '—'} />
        </Card>

        {/* Top sellers */}
        {topSellers.length > 0 && (
          <Card style={{ gap: spacing[3] }}>
            <Text variant="label">Top vendeurs</Text>
            {topSellers.map(([name, amount], i) => (
              <View key={name} style={styles.row}>
                <Text variant="caption" style={{ width: 20, color: palette.textSecondary }}>#{i + 1}</Text>
                <Text variant="body" style={{ flex: 1 }}>{name}</Text>
                <Text variant="label">{fmt(amount, currency)}</Text>
              </View>
            ))}
          </Card>
        )}

        {/* Stock */}
        <Card style={{ gap: spacing[3] }}>
          <Text variant="label">Stock</Text>
          <Row label="Valeur d'achat totale" value={fmt(stockValue, currency)} />
          <Row label="Valeur de vente totale" value={fmt(stockSaleValue, currency)} accent={palette.success} />
          <Row label="Marge potentielle" value={pct(potentialMargin)} accent={palette.success} />
          <Row label="Produits en stock faible" value={String(lowStock.length)} accent={lowStock.length > 0 ? palette.warning : undefined} />
          <Row label="Ruptures de stock" value={String(outOfStock.length)} accent={outOfStock.length > 0 ? palette.danger : undefined} />
        </Card>

        {/* Low stock list */}
        {lowStock.length > 0 && (
          <Card style={{ gap: spacing[2] }}>
            <Text variant="label">À réapprovisionner</Text>
            {lowStock.map(p => (
              <View key={p.id} style={styles.row}>
                <Text variant="body" style={{ flex: 1 }} numberOfLines={1}>{p.name}</Text>
                <Text variant="caption" style={{ color: p.stock_qty === 0 ? palette.danger : palette.warning }}>
                  {p.stock_qty} / seuil {p.reorder_level} {p.unit}
                </Text>
              </View>
            ))}
          </Card>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.background },
  hdr: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: spacing[5], borderBottomWidth: 1, borderBottomColor: palette.border },
  content: { padding: spacing[5], gap: spacing[4], paddingBottom: spacing[10] },
  periodRow: { flexDirection: 'row', gap: spacing[2] },
  periodChip: { flex: 1, paddingVertical: spacing[2], alignItems: 'center', borderRadius: radius.md, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface },
  periodActive: { backgroundColor: palette.primary, borderColor: palette.primary },
  revenueCard: { alignItems: 'center', gap: spacing[1], backgroundColor: colors.success[50], borderColor: colors.success[100] },
  barsRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing[1], height: 96 },
  barWrap: { flex: 1, alignItems: 'center', gap: spacing[1], justifyContent: 'flex-end' },
  bar: { width: '100%', backgroundColor: palette.primary, borderRadius: radius.sm, minHeight: 4 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing[2] },
});
