import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Animated, Easing, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Card } from '@/src/components/ui/Card';
import { SkeletonKpiGrid } from '@/src/components/ui/SkeletonPlaceholder';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing, radius } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useVentesStore } from '@/stores/ventes';
import { useProductStore } from '@/stores/products';
import { useExpensesStore } from '@/stores/expenses';
import { useRapportsStore } from '@/stores/rapports';

function fmt(n: number, cur: string) {
  return `${Math.round(n).toLocaleString('fr-FR')} ${cur}`;
}

type Period = 'semaine' | 'mois' | 'trimestre';
const PERIOD_DAYS: Record<Period, number> = { semaine: 7, mois: 30, trimestre: 90 };
const PERIOD_LABEL: Record<Period, string> = { semaine: 'Cette semaine', mois: 'Ce mois', trimestre: 'Ce trimestre' };
const PERIOD_PAST: Record<Period, string>  = { semaine: 'la semaine dernière', mois: 'le mois dernier', trimestre: 'le trimestre dernier' };
const PERIOD_SELLER: Record<Period, string> = { semaine: 'de la semaine', mois: 'du mois', trimestre: 'du trimestre' };

// ── Mini stat card ─────────────────────────────────────────────────────────────

function ValueSkeleton() {
  const { palette } = useTheme();
  const pulse = useRef(new Animated.Value(0.3)).current;
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.7, duration: 900, useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
        Animated.timing(pulse, { toValue: 0.3, duration: 900, useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
      ])
    ).start();
  }, [pulse]);
  return (
    <View style={{ height: 22, width: 88, borderRadius: 6, overflow: 'hidden', marginVertical: 1 }}>
      <Animated.View style={{ flex: 1, backgroundColor: palette.successLight, opacity: pulse }} />
    </View>
  );
}

function StatCard({
  label, value, accent, bg, note, loading,
}: {
  label: string; value: string; accent: string; bg: string; note?: string; loading?: boolean;
}) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  return (
    <Card style={[styles.statCard, { backgroundColor: bg }]}>
      <Text style={styles.statLabel}>{label}</Text>
      {loading ? <ValueSkeleton /> : (
        <Text style={[styles.statValue, { color: accent }]} numberOfLines={2}>
          {value}
        </Text>
      )}
      {note ? <Text style={styles.statNote}>{note}</Text> : null}
    </Card>
  );
}

// ── Main screen ────────────────────────────────────────────────────────────────

export default function RapportsScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const session    = useAuthStore(s => s.session);
  const businessId = session?.activeBusiness?.id ?? '';
  const userId     = session?.user.id ?? '';
  const currency   = session?.activeBusiness?.currency ?? 'GNF';
  const role       = session?.activeMembership?.role;

  useEffect(() => { if (role === 'vendeur') router.back(); }, [role]);

  const { sales, loading: salesLoading, fetchSales } = useVentesStore();
  const { products, fetchProducts }                  = useProductStore();
  const { expenses, fetchExpenses }                  = useExpensesStore();

  const [period, setPeriod] = useState<Period>('mois');
  const { allPayments, cogsByOrder, cogsLoading } = useRapportsStore();

  useEffect(() => {
    if (!businessId) return;
    fetchSales(businessId);
    fetchExpenses(businessId);
  }, [businessId]);

  useFocusEffect(useCallback(() => {
    if (!businessId) return;
    fetchProducts(businessId, userId);
  }, [businessId, userId]));

  // ── Date windows ──────────────────────────────────────────────────────────────
  const cutoff = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - PERIOD_DAYS[period]);
    return d;
  }, [period]);

  const prevCutoff = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 2 * PERIOD_DAYS[period]);
    return d;
  }, [period]);

  // ── Sales for current period (used only for top-sellers section) ─────────────
  const periodSales = useMemo(
    () => sales.filter(s => s.status === 'paye' && new Date(s.paid_at ?? s.created_at) >= cutoff),
    [sales, cutoff],
  );

  // ── Payment-based revenue (cash-basis: count every franc on the day received) ─
  // allPayments contains one row per payment, with the actual payment date.
  // This means partial credit payments appear in the period they were received, not the sale date.
  const periodPayments = useMemo(
    () => allPayments.filter(p => new Date(p.date) >= cutoff),
    [allPayments, cutoff],
  );
  const prevPeriodPayments = useMemo(
    () => allPayments.filter(p => new Date(p.date) >= prevCutoff && new Date(p.date) < cutoff),
    [allPayments, prevCutoff, cutoff],
  );

  const revenue          = periodPayments.reduce((s, p) => s + p.amount, 0);
  const prevRevenue      = prevPeriodPayments.reduce((s, p) => s + p.amount, 0);
  const periodOrderCount = new Set(periodPayments.map(p => p.order_id)).size;
  const deltaAmt         = revenue - prevRevenue;
  const deltaPct         = prevRevenue > 0 ? (deltaAmt / prevRevenue) * 100 : null;

  // ── Expenses for current period ───────────────────────────────────────────────
  const periodExpenses = useMemo(
    () => expenses
      .filter(e => e.status === 'approuve' && new Date(e.date) >= cutoff)
      .reduce((s, e) => s + e.amount, 0),
    [expenses, cutoff],
  );

  // ── COGS for current period (cost of goods whose payments fell in this window) ─
  const periodCOGS = useMemo(() => {
    const orderIds = new Set(periodPayments.map(p => p.order_id));
    return Object.entries(cogsByOrder)
      .filter(([id]) => orderIds.has(id))
      .reduce((s, [, cost]) => s + cost, 0);
  }, [periodPayments, cogsByOrder]);

  // ── Net ───────────────────────────────────────────────────────────────────────
  const net = revenue - periodCOGS - periodExpenses;

  // ── Credit ───────────────────────────────────────────────────────────────────
  const creditSales   = sales.filter(s => s.status === 'credit');
  // remaining = catalog total minus any partial payments already received
  const creditPending = creditSales.reduce((s, v) => s + v.total_amount - (v.discount_amount ?? 0) - (v.amount_paid ?? 0), 0);
  const creditCount   = new Set(creditSales.map(s => s.client_id ?? s.customer_name ?? s.id)).size;

  // ── Stock ─────────────────────────────────────────────────────────────────────
  const stockValue = products.reduce((s, p) => s + p.cost_price * p.stock_qty, 0);
  const lowStock   = products.filter(p => p.reorder_level > 0 && p.stock_qty <= p.reorder_level);

  // ── Top sellers ───────────────────────────────────────────────────────────────
  // Use actual payments (same basis as overall revenue) so percentages stay ≤ 100%.
  const periodPaymentsByOrder = useMemo(() => {
    const m: Record<string, number> = {};
    for (const p of periodPayments) m[p.order_id] = (m[p.order_id] ?? 0) + p.amount;
    return m;
  }, [periodPayments]);

  const sellerMap = new Map<string, { count: number; revenue: number }>();
  for (const s of periodSales) {
    const cur = sellerMap.get(s.seller_name) ?? { count: 0, revenue: 0 };
    const rev = periodPaymentsByOrder[s.id as string] ?? (s.total_amount - (s.discount_amount ?? 0));
    sellerMap.set(s.seller_name, { count: cur.count + 1, revenue: cur.revenue + rev });
  }
  const topSellers        = Array.from(sellerMap.entries()).sort((a, b) => b[1].revenue - a[1].revenue).slice(0, 5);
  const hasMultipleSellers = sellerMap.size > 1;

  // ── Bar chart ─────────────────────────────────────────────────────────────────
  const chartBuckets = useMemo(() => {
    const today = new Date();
    const buckets: { key: string; label: string; val: number }[] = [];

    if (period === 'trimestre') {
      for (let w = 12; w >= 0; w--) {
        const d = new Date(today);
        d.setDate(today.getDate() - w * 7);
        buckets.push({ key: `w${w}`, label: w === 0 ? 'Récent' : `${d.getDate()}/${d.getMonth() + 1}`, val: 0 });
      }
      for (const p of periodPayments) {
        const daysAgo = Math.floor((today.getTime() - new Date(p.date).getTime()) / 86_400_000);
        const idx = 12 - Math.min(Math.floor(daysAgo / 7), 12);
        if (idx >= 0) buckets[idx].val += p.amount;
      }
    } else {
      const days = PERIOD_DAYS[period];
      const bucketMap = new Map<string, number>();
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(today.getDate() - i);
        const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
        buckets.push({ key, label: period === 'semaine' ? d.toLocaleDateString('fr-FR', { weekday: 'short' }) : '', val: 0 });
        bucketMap.set(key, buckets.length - 1);
      }
      for (const p of periodPayments) {
        const d = new Date(p.date);
        const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
        const idx = bucketMap.get(key);
        if (idx !== undefined) buckets[idx].val += p.amount;
      }
    }
    return buckets;
  }, [periodPayments, period]);

  const maxBar = Math.max(...chartBuckets.map(b => b.val), 1);

  if (role === 'vendeur') return null;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>

      {/* Header */}
      <View style={styles.hdr}>
        <Pressable onPress={() => router.back()}>
          <Text variant="body" color="secondary">‹ Retour</Text>
        </Pressable>
        <Text variant="h4">Mes chiffres</Text>
        <View style={{ width: 60 }} />
      </View>

      {salesLoading && sales.length === 0 ? (
        <SkeletonKpiGrid />
      ) : (
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

        {/* Period selector */}
        <View style={styles.periodRow}>
          {(['semaine', 'mois', 'trimestre'] as Period[]).map(p => (
            <Pressable key={p} onPress={() => setPeriod(p)}
              style={[styles.periodChip, period === p && styles.periodActive]}>
              <Text style={[styles.periodLabel, period === p && styles.periodLabelActive]}>
                {p === 'semaine' ? 'Semaine' : p === 'mois' ? 'Mois' : 'Trimestre'}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* Hero — Vendu */}
        <Card style={styles.hero}>
          <Text style={styles.heroCaption}>{PERIOD_LABEL[period]}</Text>
          <Text style={styles.heroAmount}>{fmt(revenue, currency)}</Text>
          <Text style={styles.heroSub}>
            {periodOrderCount} vente{periodOrderCount !== 1 ? 's' : ''} encaissée{periodOrderCount !== 1 ? 's' : ''}
          </Text>

          {/* Comparison — amber if down, green if up, never red */}
          {deltaPct !== null && (
            <View style={[styles.deltaRow, { backgroundColor: deltaAmt >= 0 ? '#D1FAE5' : '#FEF3C7' }]}>
              <Text style={[styles.deltaText, { color: deltaAmt >= 0 ? '#065F46' : '#92400E' }]}>
                {deltaAmt >= 0
                  ? `↑ +${deltaPct.toFixed(1)}% vs ${PERIOD_PAST[period]}`
                  : `En baisse de ${Math.abs(deltaPct).toFixed(1)}% vs ${PERIOD_PAST[period]}`}
              </Text>
            </View>
          )}

          {revenue === 0 && periodOrderCount === 0 && (
            <Text style={styles.zeroNote}>
              Aucun paiement reçu sur cette période — les chiffres apparaîtront dès la première vente.
            </Text>
          )}
        </Card>

        {/* Row 1: Dépenses + Bénéfice */}
        <View style={styles.gridRow}>
          <StatCard
            label="Mes dépenses"
            value={fmt(periodExpenses, currency)}
            accent="#92400E"
            bg="#FFFBEB"
            note={undefined}
          />
          <StatCard
            label="Mon bénéfice"
            value={fmt(net, currency)}
            accent="#065F46"
            bg="#ECFDF5"
            loading={cogsLoading}
          />
        </View>

        {/* Row 2: Clients qui doivent + Valeur du stock */}
        <View style={styles.gridRow}>
          <StatCard
            label="Clients qui me doivent"
            value={creditPending > 0 ? fmt(creditPending, currency) : '—'}
            accent={creditPending > 0 ? '#92400E' : palette.textSecondary}
            bg={creditPending > 0 ? '#FFFBEB' : palette.surface}
            note={creditCount > 0 ? `${creditCount} client${creditCount > 1 ? 's' : ''}` : 'Tout est réglé'}
          />
          <StatCard
            label="Valeur de mon stock"
            value={fmt(stockValue, currency)}
            accent="#1D4ED8"
            bg="#EFF6FF"
          />
        </View>

        {/* Bar chart — activity */}
        <Card style={{ gap: spacing[3] }}>
          <Text style={styles.sectionTitle}>Activité</Text>
          <View style={styles.barsRow}>
            {chartBuckets.map((b, i) => (
              <View key={b.key ?? i} style={styles.barWrap}>
                <View style={[styles.bar, { height: Math.max(4, (b.val / maxBar) * 72) }]} />
                {(period === 'semaine') && (
                  <Text style={styles.barLabel} numberOfLines={1}>{b.label}</Text>
                )}
              </View>
            ))}
          </View>
        </Card>

        {/* Produits à racheter */}
        {lowStock.length > 0 && (
          <Card style={{ gap: spacing[3] }}>
            <Text style={styles.sectionTitle}>À racheter</Text>
            {lowStock.map(p => (
              <View key={p.id} style={styles.listRow}>
                <Text variant="body" style={{ flex: 1 }} numberOfLines={1}>{p.name}</Text>
                <Text style={[styles.stockBadge, {
                  color: p.stock_qty === 0 ? '#92400E' : '#D97706',
                  backgroundColor: p.stock_qty === 0 ? '#FEF3C7' : '#FFFBEB',
                }]}>
                  {p.stock_qty === 0 ? 'Épuisé' : `${p.stock_qty} restant${p.stock_qty > 1 ? 's' : ''}`}
                </Text>
              </View>
            ))}
          </Card>
        )}

        {/* Meilleurs vendeurs — only when team has multiple sellers */}
        {hasMultipleSellers && topSellers.length > 0 && (
          <Card style={{ gap: spacing[3] }}>
            <Text style={styles.sectionTitle}>Vendeurs {PERIOD_SELLER[period]}</Text>
            {topSellers.map(([name, stats], i) => {
              const pct = revenue > 0 ? (stats.revenue / revenue) * 100 : 0;
              return (
                <View key={name} style={{ gap: spacing[1] }}>
                  <View style={styles.listRow}>
                    <Text variant="caption" style={{ width: 18, color: palette.textSecondary }}>#{i + 1}</Text>
                    <Text variant="body" style={{ flex: 1 }} numberOfLines={1}>{name}</Text>
                    <Text variant="caption" color="secondary">{fmt(stats.revenue, currency)}</Text>
                  </View>
                  <View style={styles.barTrack}>
                    <View style={[styles.barFill, { width: `${pct}%` as unknown as number }]} />
                  </View>
                </View>
              );
            })}
          </Card>
        )}

      </ScrollView>
      )}
    </SafeAreaView>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
  safe:    { flex: 1, backgroundColor: p.background },
  hdr:     {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing[5], paddingVertical: spacing[4],
    backgroundColor: p.background,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.border,
  },
  content: { padding: spacing[4], gap: spacing[4], paddingBottom: spacing[10] },

  // Period chips
  periodRow:        { flexDirection: 'row', gap: spacing[2] },
  periodChip:       {
    flex: 1, paddingVertical: spacing[2], alignItems: 'center',
    borderRadius: radius.md, borderWidth: 1.5, borderColor: p.border,
    backgroundColor: p.surface,
  },
  periodActive:     { backgroundColor: p.textPrimary, borderColor: p.textPrimary },
  periodLabel:      { fontSize: 13, fontWeight: '600' as const, color: p.textSecondary },
  periodLabelActive:{ color: p.background },

  // Hero card
  hero:       { gap: spacing[2], alignItems: 'center', paddingVertical: spacing[5], backgroundColor: p.surface },
  heroCaption:{ fontSize: 13, color: p.textSecondary, fontWeight: '500' as const },
  heroAmount: { fontSize: 32, fontWeight: '800' as const, color: p.textPrimary, letterSpacing: -0.5, lineHeight: 42 },
  heroSub:    { fontSize: 13, color: p.textSecondary },
  deltaRow:   {
    marginTop: spacing[2], paddingHorizontal: spacing[4], paddingVertical: spacing[2],
    borderRadius: radius.full,
  },
  deltaText:  { fontSize: 13, fontWeight: '600' as const, textAlign: 'center' },
  zeroNote:   { fontSize: 13, color: p.textSecondary, textAlign: 'center', paddingHorizontal: spacing[4] },

  // 2-col grid
  gridRow:   { flexDirection: 'row', gap: spacing[4] },
  statCard:  { flex: 1, gap: spacing[1], minHeight: 90 },
  statLabel: { fontSize: 12, color: p.textSecondary, fontWeight: '500' as const },
  statValue: { fontSize: 16, fontWeight: '700' as const, lineHeight: 22 },
  statNote:  { fontSize: 11, color: p.textSecondary },

  // Section title (inside cards)
  sectionTitle: { fontSize: 14, fontWeight: '700' as const, color: p.textPrimary },

  // Bar chart
  barsRow:  { flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 80 },
  barWrap:  { flex: 1, alignItems: 'center', gap: 3, justifyContent: 'flex-end' },
  bar:      { width: '100%', backgroundColor: p.primary, borderRadius: 3, minHeight: 4 },
  barLabel: { fontSize: 9, color: p.textSecondary, textAlign: 'center' },

  // List rows (low stock, sellers)
  listRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  stockBadge: {
    fontSize: 12, fontWeight: '600' as const,
    paddingHorizontal: spacing[2], paddingVertical: 2,
    borderRadius: radius.sm,
  },

  // Seller progress bar
  barTrack: {
    height: 4, backgroundColor: p.border, borderRadius: 2,
    marginLeft: 18, marginRight: 4,
  },
  barFill: { height: 4, backgroundColor: p.primary, borderRadius: 2 },
  });
}
