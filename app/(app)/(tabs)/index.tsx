import { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useFocusEffect } from 'expo-router';
import { Button } from '@/src/components/ui/Button';
import { Card } from '@/src/components/ui/Card';
import { Text } from '@/src/components/ui/Text';
import { palette, spacing } from '@/src/theme';
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
  const selectBusiness = useAuthStore(s => s.selectBusiness);
  const business = session?.activeBusiness;
  const role = session?.activeMembership?.role;
  const isInvestisseur = role === 'investisseur';
  const isVendeur = role === 'vendeur';
  const businessId = business?.id ?? '';
  const userId = session?.user.id ?? '';
  const currency = business?.currency ?? 'GNF';
  const memberships = session?.memberships ?? [];

  const openBusinessPicker = useCallback(() => {
    const others = memberships.filter(m => m.business_id !== businessId);
    const buttons: { text: string; onPress?: () => void; style?: 'cancel' | 'destructive' }[] = [];
    others.forEach(m => {
      buttons.push({
        text: (m.business as { name?: string })?.name ?? m.business_id,
        onPress: () => { selectBusiness(m.business_id); router.replace('/(app)/(tabs)/'); },
      });
    });
    if (memberships.length < 2) {
      buttons.push({ text: '+ Rejoindre un commerce', onPress: () => router.push('/(app)/onboarding/rejoindre') });
    }
    buttons.push({ text: 'Annuler', style: 'cancel' });
    Alert.alert(business?.name ?? '', 'Changer de commerce', buttons);
  }, [memberships, businessId, business, selectBusiness]);

  const { products, fetchProducts } = useProductStore();
  const [kpis, setKpis] = useState<KPIs | null>(null);
  const [bestSellers, setBestSellers] = useState<BestSeller[]>([]);
  const [loading, setLoading] = useState(true);

  const loadAll = useCallback(async () => {
    if (!businessId) return;
    setLoading(true);
    if (isInvestisseur) {
      await loadKpis();
    } else {
      await Promise.all([fetchProducts(businessId, userId), loadKpis(), loadBestSellers()]);
    }
    setLoading(false);
  }, [businessId, userId, isInvestisseur]);

  // Reload every time this tab gains focus (catches sales made in caisse)
  useFocusEffect(
    useCallback(() => {
      loadAll();
    }, [loadAll]),
  );

  const loadKpis = async () => {
    if (isInvestisseur) {
      const { data } = await supabase.rpc('get_business_kpis', { p_business_id: businessId });
      if (data) {
        setKpis({
          revenue_today:    (data.revenue_today    ?? 0) / 100,
          revenue_yesterday:(data.revenue_yesterday?? 0) / 100,
          revenue_month:    (data.revenue_month    ?? 0) / 100,
          sales_today:       data.sales_today      ?? 0,
          credit_total:     (data.credit_total     ?? 0) / 100,
          credit_count:      data.credit_count     ?? 0,
          low_stock: 0,
          expenses_month:   (data.expenses_month   ?? 0) / 100,
        });
      }
      return;
    }

    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const today = `${y}-${m}-${d}`;
    const yestD = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const yesterday = `${yestD.getFullYear()}-${String(yestD.getMonth() + 1).padStart(2, '0')}-${String(yestD.getDate()).padStart(2, '0')}`;
    const monthStart = `${y}-${m}-01`;

    const lowStock = useProductStore.getState().products.filter(
      p => p.stock_qty <= p.reorder_level && p.reorder_level > 0,
    ).length;

    const todayStart = `${today}T00:00:00.000Z`;
    const monthStartISO = `${monthStart}T00:00:00.000Z`;
    const yestStart = `${yesterday}T00:00:00.000Z`;

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
        .gte('paid_at', monthStartISO),
      supabase
        .from('sale_orders')
        .select('id, total_amount, customer_name')
        .eq('business_id', businessId)
        .eq('status', 'credit'),
      supabase
        .from('expenses')
        .select('amount')
        .eq('business_id', businessId)
        .eq('status', 'approuve')
        .gte('date', monthStart),
    ]);

    const sum = (rows: { total_amount?: number; amount?: number }[] | null, key: 'total_amount' | 'amount' = 'total_amount') =>
      (rows ?? []).reduce((s, r) => s + (r[key] ?? 0), 0) / 100;

    type CreditOrder = { id: string; total_amount: number; customer_name: string | null };
    const creditOrders = (creditRes.data ?? []) as CreditOrder[];
    const creditIds = creditOrders.map(o => o.id);

    let creditTotal = 0;
    let creditCount = 0;

    if (creditIds.length > 0) {
      const { data: creditPays } = await supabase
        .from('payments')
        .select('order_id, amount')
        .in('order_id', creditIds);

      const paidByOrder: Record<string, number> = {};
      for (const p of (creditPays ?? []) as { order_id: string; amount: number }[]) {
        paidByOrder[p.order_id] = (paidByOrder[p.order_id] ?? 0) + p.amount;
      }

      const clientsOwing = new Set<string>();
      let anonCount = 0;
      for (const order of creditOrders) {
        const remaining = (order.total_amount - (paidByOrder[order.id] ?? 0)) / 100;
        if (remaining > 0.01) {
          creditTotal += remaining;
          if (order.customer_name) clientsOwing.add(order.customer_name);
          else anonCount++;
        }
      }
      creditCount = clientsOwing.size + anonCount;
    }

    setKpis({
      revenue_today: sum(todayRes.data as { total_amount: number }[] | null),
      revenue_yesterday: sum(yestRes.data as { total_amount: number }[] | null),
      revenue_month: sum(monthRes.data as { total_amount: number }[] | null),
      sales_today: todayRes.data?.length ?? 0,
      credit_total: creditTotal,
      credit_count: creditCount,
      low_stock: lowStock,
      expenses_month: sum(expensesRes.data as { amount: number }[] | null, 'amount'),
    });
  };

  const loadBestSellers = async () => {
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

    const { data } = await supabase.rpc('get_best_sellers', {
      p_business_id: businessId,
      p_month_start: monthStart,
      p_limit:       5,
    });

    setBestSellers(
      (data ?? []).map((r: BestSeller) => ({
        product_id:    r.product_id,
        product_name:  r.product_name,
        total_qty:     Number(r.total_qty),
        total_revenue: Number(r.total_revenue) / 100,
      })),
    );
  };

  const lowStock = useProductStore.getState().products.filter(
    p => p.stock_qty <= p.reorder_level && p.reorder_level > 0,
  ).length;

  const salesCount = kpis?.sales_today ?? 0;
  const delta = (kpis?.revenue_today ?? 0) - (kpis?.revenue_yesterday ?? 0);
  const deltaArrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '—';
  const deltaColor = delta > 0 ? palette.success : delta < 0 ? palette.danger : palette.textSecondary;
  const showAttentionCards = (kpis?.credit_count ?? 0) > 0 || lowStock > 0;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

        {/* Header */}
        <View style={styles.header}>
          <Pressable onPress={openBusinessPicker} style={({ pressed }) => [{ opacity: pressed ? 0.6 : 1 }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text variant="h3">{business?.name}</Text>
              <Text variant="caption" color="secondary">⌄</Text>
            </View>
          </Pressable>
        </View>

        {loading ? (
          <Text variant="body" color="secondary" style={{ textAlign: 'center', marginTop: spacing[6] }}>
            Chargement…
          </Text>
        ) : !isInvestisseur && !isVendeur && products.length === 0 ? (
          /* ── Welcome state: no products yet (admin/manager) ── */
          <Card style={styles.welcome}>
            <Text style={styles.welcomeEmoji}>🎉</Text>
            <Text variant="h4" style={{ textAlign: 'center' }}>Félicitations !</Text>
            <Text variant="body" color="secondary" style={{ textAlign: 'center' }}>
              Votre commerce <Text variant="label">{business?.name}</Text> est prêt.{'\n'}
              Commencez par ajouter vos premiers produits.
            </Text>
            <Button
              label="Ajouter un produit"
              onPress={() => router.push('/(app)/(tabs)/catalogue')}
              fullWidth
              style={{ marginTop: spacing[2] }}
            />
          </Card>
        ) : isVendeur && products.length === 0 ? (
          /* ── Empty state for vendeur: no products configured yet ── */
          <Card style={styles.welcome}>
            <Text variant="h4" style={{ textAlign: 'center' }}>Aucun produit</Text>
            <Text variant="body" color="secondary" style={{ textAlign: 'center' }}>
              Votre commerce n'a pas encore de produits configurés.{'\n'}
              Contactez votre gérant pour commencer à vendre.
            </Text>
          </Card>
        ) : (
          <>
            {/* ── Zone 1: Hero — Today ── */}
            <Card onPress={isInvestisseur ? undefined : () => router.push('/ventes')} style={styles.heroCard}>
              <View style={styles.heroTop}>
                <Text variant="caption" color="secondary">Aujourd'hui</Text>
                <Text
                  variant="amountLarge"
                  color={salesCount > 0 ? 'success' : undefined}
                  style={styles.heroAmount}
                  adjustsFontSizeToFit
                  numberOfLines={1}
                  minimumFontScale={0.5}
                >
                  {fmt(kpis?.revenue_today ?? 0, currency)}
                </Text>
                <Text variant="caption" color="secondary" style={{ marginTop: spacing[1] }}>
                  {salesCount} vente{salesCount !== 1 ? 's' : ''}
                </Text>
              </View>
              <View style={styles.heroComparison}>
                <Text variant="caption" color="secondary">
                  Hier: {fmt(kpis?.revenue_yesterday ?? 0, currency)}
                </Text>
                <Text variant="caption" style={{ color: deltaColor, marginLeft: spacing[1] }}>
                  {deltaArrow}
                </Text>
              </View>
            </Card>

            {/* ── Zone 2: Attention — conditional ── */}
            {showAttentionCards ? (
              <View style={styles.attentionZone}>
                {(kpis?.credit_count ?? 0) > 0 && (
                  <KpiCard
                    label="Clients qui doivent"
                    value={fmt(kpis?.credit_total ?? 0, currency)}
                    sub={`${kpis?.credit_count} client${(kpis?.credit_count ?? 0) > 1 ? 's' : ''}`}
                    onPress={isInvestisseur ? undefined : () => router.push('/credits')}
                    accent={palette.warning}
                  />
                )}
                {lowStock > 0 && (
                  <KpiCard
                    label="À racheter"
                    value={String(lowStock)}
                    sub={`produit${lowStock > 1 ? 's' : ''} à racheter`}
                    onPress={isInvestisseur || isVendeur ? undefined : () => router.push('/(app)/(tabs)/catalogue')}
                    accent={palette.danger}
                  />
                )}
              </View>
            ) : (
              <Text variant="caption" color="secondary" style={styles.allGood}>
                Tout est en ordre ✓
              </Text>
            )}

            {/* ── Best sellers ── */}
            {bestSellers.length > 0 && (
              <View style={styles.section}>
                <Text variant="label" color="secondary" style={styles.sectionTitle}>
                  Produits qui marchent
                </Text>
                {bestSellers.map((bs, i) => (
                  <View key={bs.product_id} style={styles.bsRow}>
                    <Text variant="caption" style={{ width: 20, color: palette.textSecondary }}>#{i + 1}</Text>
                    <Text variant="body" style={{ flex: 1 }} numberOfLines={1}>{bs.product_name}</Text>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text variant="label">{fmt(bs.total_revenue, currency)}</Text>
                      <Text variant="caption" color="secondary">{bs.total_qty} unité{bs.total_qty > 1 ? 's' : ''}</Text>
                    </View>
                  </View>
                ))}
              </View>
            )}

            {/* ── Zone 3: Month context ── */}
            <Text variant="caption" color="secondary" style={styles.monthLine}>
              Ce mois: {fmt(kpis?.revenue_month ?? 0, currency)}
            </Text>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.background },
  content: { padding: spacing[5], gap: spacing[4], paddingBottom: spacing[10] },
  header: { paddingBottom: spacing[2] },

  // Zone 1
  heroCard: {},
  heroTop: {
    gap: spacing[1],
  },
  heroAmount: {
    fontSize: 52,
    lineHeight: 60,
  },
  heroComparison: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: spacing[3],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: palette.border,
  },

  // Zone 2
  attentionZone: { gap: spacing[3] },
  kpi: { gap: spacing[1] },
  allGood: { textAlign: 'center', paddingVertical: spacing[3] },

  // Zone 3
  monthLine: { textAlign: 'center', paddingVertical: spacing[2] },

  // Welcome state
  welcome: { alignItems: 'center', gap: spacing[4], paddingVertical: spacing[8], paddingHorizontal: spacing[6] },
  welcomeEmoji: { fontSize: 52 },

  // Best sellers
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
});
