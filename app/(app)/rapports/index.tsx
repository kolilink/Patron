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

function Row({ label, value, accent, muted }: {
  label: string; value: string; accent?: string; muted?: boolean;
}) {
  return (
    <View style={styles.row}>
      <Text variant={muted ? 'bodySmall' : 'body'} color={muted ? 'secondary' : 'primary'} style={{ flex: 1 }}>
        {label}
      </Text>
      <Text
        variant={muted ? 'bodySmall' : 'label'}
        color={muted ? 'secondary' : 'primary'}
        style={accent ? { color: accent } : undefined}
      >
        {value}
      </Text>
    </View>
  );
}

export default function RapportsScreen() {
  const session = useAuthStore(s => s.session);
  const businessId = session?.activeBusiness?.id ?? '';
  const userId = session?.user.id ?? '';
  const currency = session?.activeBusiness?.currency ?? 'GNF';

  const { sales, fetchSales } = useVentesStore();
  const { products, fetchProducts } = useProductStore();
  const [period, setPeriod] = useState<Period>('30j');

  useEffect(() => {
    if (!businessId) return;
    fetchSales(businessId);
    fetchProducts(businessId, userId);
  }, [businessId]);

  // Current period window
  const cutoff = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - PERIOD_DAYS[period]);
    return d;
  }, [period]);

  // Previous period window (same length, immediately before current)
  const prevCutoff = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 2 * PERIOD_DAYS[period]);
    return d;
  }, [period]);

  const filteredSales = useMemo(
    () => sales.filter(s => s.status === 'paye' && new Date(s.paid_at ?? s.created_at) >= cutoff),
    [sales, cutoff],
  );

  const prevFilteredSales = useMemo(
    () => sales.filter(s =>
      s.status === 'paye' &&
      new Date(s.paid_at ?? s.created_at) >= prevCutoff &&
      new Date(s.paid_at ?? s.created_at) < cutoff,
    ),
    [sales, prevCutoff, cutoff],
  );

  // Revenue
  const revenue = filteredSales.reduce((s, v) => s + v.total_amount, 0);
  const prevRevenue = prevFilteredSales.reduce((s, v) => s + v.total_amount, 0);
  const comparisonDeltaAmt = revenue - prevRevenue;
  const comparisonDeltaPct = prevRevenue > 0 ? (comparisonDeltaAmt / prevRevenue) * 100 : null;

  // Credit
  const creditPending = sales.filter(s => s.status === 'credit').reduce((s, v) => s + v.total_amount, 0);
  const creditCount = sales.filter(s => s.status === 'credit').length;

  // Stock
  const stockValue = products.reduce((s, p) => s + p.cost_price * p.stock_qty, 0);
  const stockSaleValue = products.reduce((s, p) => s + p.sale_price * p.stock_qty, 0);
  const potentialProfit = stockSaleValue - stockValue;
  const potentialMargin = stockSaleValue > 0 ? ((stockSaleValue - stockValue) / stockSaleValue) * 100 : 0;
  const lowStock = products.filter(p => p.stock_qty <= p.reorder_level && p.reorder_level > 0);
  const outOfStock = products.filter(p => p.stock_qty === 0);

  // Top sellers — only show section when multiple distinct sellers
  const sellerMap = new Map<string, number>();
  for (const s of filteredSales) {
    sellerMap.set(s.seller_name, (sellerMap.get(s.seller_name) ?? 0) + s.total_amount);
  }
  const topSellers = Array.from(sellerMap.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const hasMultipleSellers = sellerMap.size > 1;

  // Chart buckets — respects the selected period
  const chartBuckets = useMemo(() => {
    const today = new Date();
    const buckets: { key: string; label: string; val: number }[] = [];

    if (period === '90j') {
      // Weekly buckets: 13 weeks
      const weeks = 13;
      for (let w = weeks - 1; w >= 0; w--) {
        const d = new Date(today);
        d.setDate(today.getDate() - w * 7);
        buckets.push({
          key: `w${w}`,
          label: w === 0 ? 'Récent' : `${d.getDate()}/${d.getMonth() + 1}`,
          val: 0,
        });
      }
      for (const s of filteredSales) {
        const saleDate = new Date(s.paid_at ?? s.created_at);
        const daysAgo = Math.floor((today.getTime() - saleDate.getTime()) / (1000 * 60 * 60 * 24));
        const weekSlot = Math.min(Math.floor(daysAgo / 7), weeks - 1);
        const idx = weeks - 1 - weekSlot;
        if (idx >= 0) buckets[idx].val += s.total_amount;
      }
    } else {
      // Daily buckets: 7 or 30 days
      const days = PERIOD_DAYS[period];
      const bucketMap = new Map<string, number>();
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(today.getDate() - i);
        const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
        const label = period === '7j'
          ? d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' })
          : '';
        buckets.push({ key, label, val: 0 });
        bucketMap.set(key, buckets.length - 1);
      }
      for (const s of filteredSales) {
        const d = new Date(s.paid_at ?? s.created_at);
        const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
        const idx = bucketMap.get(key);
        if (idx !== undefined) buckets[idx].val += s.total_amount;
      }
    }

    return buckets;
  }, [filteredSales, period]);

  const maxBar = Math.max(...chartBuckets.map(b => b.val), 1);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.hdr}>
        <Pressable onPress={() => router.back()}><Text variant="body" color="secondary">‹ Retour</Text></Pressable>
        <Text variant="h4">Mes chiffres</Text>
        <View style={{ width: 60 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

        {/* Period filter */}
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

        {/* Zone 1 — Hero: Vendu */}
        <Card style={styles.revenueCard}>
          <Text variant="caption" color="secondary">Vendu ({PERIOD_DAYS[period]} jours)</Text>
          <Text variant="amountLarge" style={{ color: palette.success }}>{fmt(revenue, currency)}</Text>
          <Text variant="caption" color="secondary">
            {filteredSales.length} vente{filteredSales.length !== 1 ? 's' : ''} payée{filteredSales.length !== 1 ? 's' : ''}
          </Text>
          {comparisonDeltaPct !== null && (
            <View style={styles.heroComparison}>
              <Text variant="caption" style={{ color: comparisonDeltaAmt >= 0 ? palette.success : palette.danger }}>
                {comparisonDeltaAmt > 0 ? '↑' : comparisonDeltaAmt < 0 ? '↓' : '—'}{' '}
                {comparisonDeltaAmt >= 0 ? '+' : '−'}{Math.abs(comparisonDeltaPct).toFixed(1)}%
                {' '}({comparisonDeltaAmt >= 0 ? '+' : '−'}{Math.abs(Math.round(comparisonDeltaAmt)).toLocaleString('fr-FR')} {currency})
              </Text>
              <Text variant="caption" color="secondary">vs période précédente</Text>
            </View>
          )}
        </Card>

        {/* Zone 2 — Bénéfice possible */}
        {potentialProfit > 0 && (
          <Card style={styles.beneficeCard}>
            <Text variant="caption" color="secondary">Bénéfice possible</Text>
            <Text variant="amountLarge" style={{ color: palette.success }}>~{fmt(Math.round(potentialProfit), currency)}</Text>
            <Text variant="caption" color="secondary">marge {pct(potentialMargin)}</Text>
          </Card>
        )}

        {/* Zone 3 — Ventes par jour */}
        {chartBuckets.length > 0 && (
          <Card style={{ gap: spacing[3] }}>
            <Text variant="label" color="secondary">Ventes par jour</Text>
            <View style={styles.barsRow}>
              {chartBuckets.map((b, i) => (
                <View key={b.key ?? i} style={styles.barWrap}>
                  <View style={[styles.bar, { height: Math.max(4, (b.val / maxBar) * 80) }]} />
                  {period === '7j' && (
                    <Text variant="caption" color="secondary" style={{ fontSize: 9, textAlign: 'center' }} numberOfLines={1}>
                      {b.label}
                    </Text>
                  )}
                </View>
              ))}
            </View>
          </Card>
        )}

        {/* Zone 4 — Résumé des ventes */}
        <Card style={{ gap: spacing[3] }}>
          <Text variant="label">Résumé des ventes</Text>
          <Row label="Argent reçu" value={fmt(revenue, currency)} accent={palette.success} />
          <Row
            label="Clients qui doivent"
            value={creditPending > 0
              ? `${fmt(creditPending, currency)} (${creditCount} client${creditCount > 1 ? 's' : ''})`
              : '—'
            }
            accent={creditPending > 0 ? palette.warning : undefined}
          />
          <Row
            label="Vente moyenne"
            value={filteredSales.length > 0 ? fmt(Math.round(revenue / filteredSales.length), currency) : '—'}
          />
        </Card>

        {/* Zone 5 — Meilleurs vendeurs (only when multiple sellers) */}
        {hasMultipleSellers && topSellers.length > 0 && (
          <Card style={{ gap: spacing[3] }}>
            <Text variant="label">Meilleurs vendeurs</Text>
            {topSellers.map(([name, amount], i) => (
              <View key={name} style={styles.row}>
                <Text variant="caption" style={{ width: 20, color: palette.textSecondary }}>#{i + 1}</Text>
                <Text variant="body" style={{ flex: 1 }}>{name}</Text>
                <Text variant="label">{fmt(amount, currency)}</Text>
              </View>
            ))}
          </Card>
        )}

        {/* Zone 6 — Stock */}
        <Card style={{ gap: spacing[3] }}>
          <Text variant="label">Stock</Text>
          <Row label="Ce que ça peut rapporter" value={fmt(stockSaleValue, currency)} accent={palette.success} />
          <Row label="Ce que j'ai payé" value={fmt(stockValue, currency)} muted />
          <Row label="Produits qui finissent" value={String(lowStock.length)} accent={lowStock.length > 0 ? palette.warning : undefined} />
          <Row label="Produits finis" value={String(outOfStock.length)} accent={outOfStock.length > 0 ? palette.danger : undefined} />
        </Card>

        {/* Zone 7 — À racheter */}
        {lowStock.length > 0 && (
          <Card style={{ gap: spacing[2] }}>
            <Text variant="label">À racheter</Text>
            {lowStock.map(p => (
              <View key={p.id} style={styles.row}>
                <Text variant="body" style={{ flex: 1 }} numberOfLines={1}>{p.name}</Text>
                <Text variant="caption" style={{ color: p.stock_qty === 0 ? palette.danger : palette.warning }}>
                  {p.stock_qty} / min. {p.reorder_level} {p.unit}
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
  hdr: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    padding: spacing[5], borderBottomWidth: 1, borderBottomColor: palette.border,
  },
  content: { padding: spacing[5], gap: spacing[4], paddingBottom: spacing[10] },

  // Period filter
  periodRow: { flexDirection: 'row', gap: spacing[2] },
  periodChip: {
    flex: 1, paddingVertical: spacing[2], alignItems: 'center',
    borderRadius: radius.md, borderWidth: 1, borderColor: palette.border,
    backgroundColor: palette.surface,
  },
  periodActive: { backgroundColor: palette.primary, borderColor: palette.primary },

  // Zone 1: Hero
  revenueCard: {
    alignItems: 'center', gap: spacing[1],
    backgroundColor: colors.success[50], borderColor: colors.success[100],
  },
  heroComparison: {
    marginTop: spacing[2], paddingTop: spacing[2],
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.success[100],
    alignItems: 'center', gap: 2,
  },

  // Zone 2: Bénéfice
  beneficeCard: {
    gap: spacing[1],
    borderLeftWidth: 3, borderLeftColor: palette.success,
  },

  // Zone 3: Chart
  barsRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing[1], height: 96 },
  barWrap: { flex: 1, alignItems: 'center', gap: spacing[1], justifyContent: 'flex-end' },
  bar: { width: '100%', backgroundColor: palette.primary, borderRadius: radius.sm, minHeight: 4 },

  // Shared row
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing[2] },
});
