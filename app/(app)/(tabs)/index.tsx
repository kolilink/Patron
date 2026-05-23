import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useFocusEffect } from 'expo-router';
import { Card } from '@/src/components/ui/Card';
import { Text } from '@/src/components/ui/Text';
import { palette, spacing, colors } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useProductStore } from '@/stores/products';
import { supabase } from '@/lib/supabase';

interface KPIs {
  revenue_today: number;
  revenue_yesterday: number;
  revenue_month: number;
  sales_today: number;
  credit_total: number;
  credit_count: number;
  low_stock: number;
  expenses_month: number;
}

interface BestSeller {
  product_id: string;
  product_name: string;
  total_qty: number;
  total_revenue: number;
}

function fmt(n: number, cur: string) {
  return `${n.toLocaleString('fr-FR')} ${cur}`;
}

function KpiCard({ label, value, sub, onPress, accent }: {
  label: string; value: string; sub?: string; onPress?: () => void; accent?: string;
}) {
  return (
    <Card onPress={onPress} style={[styles.kpi, accent ? { borderLeftWidth: 3, borderLeftColor: accent } : null]}>
      <Text variant="caption" color="secondary">{label}</Text>
      <Text variant="amountLarge" style={accent ? { color: accent } : undefined}>{value}</Text>
      {sub ? <Text variant="caption" color="secondary">{sub}</Text> : null}
    </Card>
  );
}

export default function AccueilScreen() {
  const session = useAuthStore(s => s.session);
  const business = session?.activeBusiness;
  const role = session?.activeMembership?.role;
  const businessId = business?.id ?? '';
  const userId = session?.user.id ?? '';
  const currency = business?.currency ?? 'GNF';

  const { products, fetchProducts } = useProductStore();
  const [kpis, setKpis] = useState<KPIs | null>(null);
  const [bestSellers, setBestSellers] = useState<BestSeller[]>([]);
  const [loading, setLoading] = useState(true);

  const loadAll = useCallback(async () => {
    if (!businessId) return;
    setLoading(true);
    await Promise.all([fetchProducts(businessId, userId), loadKpis(), loadBestSellers()]);
    setLoading(false);
  }, [businessId, userId]);

  // Reload every time this tab gains focus (catches sales made in caisse)
  useFocusEffect(
    useCallback(() => {
      loadAll();
    }, [loadAll]),
  );

  const loadKpis = async () => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const todayStart = `${y}-${m}-${d}T00:00:00.000Z`;
    const monthStart = `${y}-${m}-01T00:00:00.000Z`;
    const yestD = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const yestStart = `${yestD.getFullYear()}-${String(yestD.getMonth() + 1).padStart(2, '0')}-${String(yestD.getDate()).padStart(2, '0')}T00:00:00.000Z`;

    const [todayRes, yestRes, monthRes, creditRes, expensesRes] = await Promise.all([
      supabase
        .from('sale_orders')
        .select('total_amount')
        .eq('business_id', businessId)
        .eq('status', 'paye')
        .gte('paid_at', todayStart),
      supabase
        .from('sale_orders')
        .select('total_amount')
        .eq('business_id', businessId)
        .eq('status', 'paye')
        .gte('paid_at', yestStart)
        .lt('paid_at', todayStart),
      supabase
        .from('sale_orders')
        .select('total_amount')
        .eq('business_id', businessId)
        .eq('status', 'paye')
        .gte('paid_at', monthStart),
      supabase
        .from('sale_orders')
        .select('id, total_amount')
        .eq('business_id', businessId)
        .eq('status', 'credit'),
      supabase
        .from('expenses')
        .select('amount')
        .eq('business_id', businessId)
        .eq('status', 'approuve')
        .gte('date', monthStart.split('T')[0]),
    ]);

    const sum = (rows: { total_amount?: number; amount?: number }[] | null, key: 'total_amount' | 'amount' = 'total_amount') =>
      (rows ?? []).reduce((s, r) => s + (r[key] ?? 0), 0);

    const lowStock = useProductStore.getState().products.filter(
      p => p.stock_qty <= p.reorder_level && p.reorder_level > 0,
    ).length;

    setKpis({
      revenue_today: sum(todayRes.data as { total_amount: number }[] | null),
      revenue_yesterday: sum(yestRes.data as { total_amount: number }[] | null),
      revenue_month: sum(monthRes.data as { total_amount: number }[] | null),
      sales_today: todayRes.data?.length ?? 0,
      credit_total: sum(creditRes.data as { total_amount: number }[] | null),
      credit_count: creditRes.data?.length ?? 0,
      low_stock: lowStock,
      expenses_month: sum(expensesRes.data as { amount: number }[] | null, 'amount'),
    });
  };

  const loadBestSellers = async () => {
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

    // Get all paid/credit order IDs this month
    const { data: orders } = await supabase
      .from('sale_orders')
      .select('id')
      .eq('business_id', businessId)
      .in('status', ['paye', 'credit'])
      .gte('sale_date', monthStart);

    if (!orders || orders.length === 0) { setBestSellers([]); return; }

    const orderIds = orders.map((o: { id: string }) => o.id);

    const { data: lines } = await supabase
      .from('so_lines')
      .select('product_id, qty, unit_price, product:products(name)')
      .in('order_id', orderIds);

    if (!lines) { setBestSellers([]); return; }

    // Aggregate by product
    const map = new Map<string, BestSeller>();
    for (const l of (lines as unknown) as Array<{ product_id: string; qty: number; unit_price: number; product: { name: string } | null }>) {
      const existing = map.get(l.product_id);
      if (existing) {
        existing.total_qty += l.qty;
        existing.total_revenue += l.qty * l.unit_price;
      } else {
        map.set(l.product_id, {
          product_id: l.product_id,
          product_name: l.product?.name ?? '—',
          total_qty: l.qty,
          total_revenue: l.qty * l.unit_price,
        });
      }
    }

    const sorted = Array.from(map.values())
      .sort((a, b) => b.total_revenue - a.total_revenue)
      .slice(0, 5);

    setBestSellers(sorted);
  };

  const lowStock = useProductStore.getState().products.filter(
    p => p.stock_qty <= p.reorder_level && p.reorder_level > 0,
  ).length;

  const isInvestisseur = role === 'investisseur';

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <View>
            <Text variant="h3">{business?.name}</Text>
            <Text variant="bodySmall" color="secondary" style={{ textTransform: 'capitalize' }}>{role}</Text>
          </View>
        </View>

        {loading ? (
          <Text variant="body" color="secondary" style={{ textAlign: 'center', marginTop: spacing[6] }}>
            Chargement…
          </Text>
        ) : (
          <>
            <View style={styles.grid}>
              <View style={styles.todayRow}>
                <KpiCard
                  label="Ventes aujourd'hui"
                  value={fmt(kpis?.revenue_today ?? 0, currency)}
                  sub={`${kpis?.sales_today ?? 0} transaction${(kpis?.sales_today ?? 0) > 1 ? 's' : ''}`}
                  onPress={() => router.push('/ventes')}
                  accent={palette.success}
                />
                <KpiCard
                  label="Hier"
                  value={fmt(kpis?.revenue_yesterday ?? 0, currency)}
                  onPress={() => router.push('/ventes')}
                />
              </View>
              <KpiCard
                label="Ventes ce mois"
                value={fmt(kpis?.revenue_month ?? 0, currency)}
                onPress={() => router.push('/ventes')}
              />
              {(kpis?.expenses_month ?? 0) > 0 && !isInvestisseur && (
                <KpiCard
                  label="Dépenses ce mois"
                  value={fmt(kpis?.expenses_month ?? 0, currency)}
                  onPress={() => router.push('/depenses')}
                  accent={palette.danger}
                />
              )}
              {(kpis?.credit_count ?? 0) > 0 && (
                <KpiCard
                  label="Créances clients"
                  value={fmt(kpis?.credit_total ?? 0, currency)}
                  sub={`${kpis?.credit_count} client${(kpis?.credit_count ?? 0) > 1 ? 's' : ''}`}
                  onPress={() => router.push('/clients')}
                  accent={palette.warning}
                />
              )}
              {lowStock > 0 && (
                <KpiCard
                  label="Stock faible"
                  value={String(lowStock)}
                  sub="produit(s) à réapprovisionner"
                  onPress={() => router.push('/(app)/(tabs)/catalogue')}
                  accent={palette.danger}
                />
              )}
            </View>

            {/* Best sellers this month */}
            {bestSellers.length > 0 && (
              <View style={styles.section}>
                <Text variant="label" color="secondary" style={styles.sectionTitle}>
                  Vos meilleurs produits
                </Text>
                {bestSellers.map((bs, i) => (
                  <View key={bs.product_id} style={styles.bsRow}>
                    <View style={[styles.bsRank, { backgroundColor: i === 0 ? colors.warning[100] : palette.primaryLight }]}>
                      <Text variant="label" style={{ color: i === 0 ? colors.warning[700] : palette.primary }}>
                        {i + 1}
                      </Text>
                    </View>
                    <Text variant="body" style={{ flex: 1 }} numberOfLines={1}>{bs.product_name}</Text>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text variant="label">{fmt(bs.total_revenue, currency)}</Text>
                      <Text variant="caption" color="secondary">{bs.total_qty} unité{bs.total_qty > 1 ? 's' : ''}</Text>
                    </View>
                  </View>
                ))}
              </View>
            )}

            {(kpis?.revenue_today === 0 && kpis?.revenue_month === 0) && (
              <Card style={styles.empty}>
                <Text variant="body" color="secondary" style={{ textAlign: 'center' }}>
                  Aucune vente enregistrée. Commencez par l'onglet Vendre.
                </Text>
              </Card>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.background },
  content: { padding: spacing[5], gap: spacing[5], paddingBottom: spacing[10] },
  header: { paddingBottom: spacing[2] },
  grid: { gap: spacing[3] },
  todayRow: { flexDirection: 'row', gap: spacing[3] },
  kpi: { gap: spacing[1], flex: 1 },
  empty: { alignItems: 'center', paddingVertical: spacing[8] },
  section: {
    backgroundColor: palette.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: palette.border,
    overflow: 'hidden',
  },
  sectionTitle: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: palette.border,
  },
  bsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: palette.border,
  },
  bsRank: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
