import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Button } from '@/src/components/ui/Button';
import { Card } from '@/src/components/ui/Card';
import { Text } from '@/src/components/ui/Text';
import { palette, radius, spacing } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useProductStore } from '@/stores/products';
import { useVentesStore } from '@/stores/ventes';
import { useChatStore } from '@/stores/chat';
import { supabase } from '@/lib/supabase';
import { isNetworkError } from '@/lib/sync';
import { saveDashboardKpiCache, getDashboardKpiCache, getKV, setKV } from '@/lib/db';


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

function OnboardingStep({ number, label, done, active }: {
  number: number; label: string; done: boolean; active: boolean;
}) {
  return (
    <View style={styles.onboardingStep}>
      <View style={[
        styles.onboardingBubble,
        done   && styles.onboardingBubbleDone,
        active && styles.onboardingBubbleActive,
      ]}>
        <Text variant="label" style={{ color: done || active ? palette.textInverse : palette.textDisabled }}>
          {done ? '✓' : String(number)}
        </Text>
      </View>
      <Text variant="body" style={{
        flex: 1,
        color: done ? palette.textSecondary : active ? palette.textPrimary : palette.textDisabled,
        textDecorationLine: done ? 'line-through' : 'none',
      }}>
        {label}
      </Text>
    </View>
  );
}

export default function AccueilScreen() {
  const session = useAuthStore(s => s.session);
  const openBusinessPicker = useAuthStore(s => s.openBusinessDrawer);
  const business = session?.activeBusiness;
  const role = session?.activeMembership?.role;
  const isInvestisseur = role === 'investisseur';
  const isVendeur = role === 'vendeur';
  const businessId = business?.id ?? '';
  const userId = session?.user.id ?? '';
  const currency = business?.currency ?? 'GNF';
  const memberships = session?.memberships ?? [];
  const totalUnread = useChatStore(s => s.boutiqueUnread + s.marcheUnread);

  const { products, fetchProducts } = useProductStore();
  const [kpis, setKpis] = useState<KPIs | null>(null);
  const [bestSellers, setBestSellers] = useState<BestSeller[]>([]);
  const [loading, setLoading] = useState(true);
  const [isOffline, setIsOffline] = useState(false);

  const welcomeBtnScale = useRef(new Animated.Value(1)).current;
  const welcomeBtnOpacity = useRef(new Animated.Value(1)).current;

  const isOwner = !isInvestisseur && !isVendeur;

  // null = not yet checked, true = dismissed, false = active
  const [onboardingDismissed, setOnboardingDismissed] = useState<boolean | null>(null);

  useEffect(() => {
    if (!userId || !businessId || !isOwner) { setOnboardingDismissed(true); return; }
    const key = `onboarding_done_${userId}_${businessId}`;
    getKV(key).then(val => {
      if (val !== null) { setOnboardingDismissed(true); return; }
      // Auto-dismiss for businesses older than 7 days — they predate this onboarding flow
      const ageMs = business?.created_at ? Date.now() - new Date(business.created_at).getTime() : Infinity;
      if (ageMs > 7 * 24 * 60 * 60 * 1000) {
        setKV(key, '1').catch(() => {});
        setOnboardingDismissed(true);
      } else {
        setOnboardingDismissed(false);
      }
    }).catch(() => setOnboardingDismissed(true));
  }, [userId, businessId, isOwner, business?.created_at]);

  const step2Done = products.length > 0;
  const step3Done = (kpis?.revenue_month ?? 0) > 0;
  const showOnboarding = isOwner && onboardingDismissed === false;

  // Permanently write flag once all steps complete
  useEffect(() => {
    if (!showOnboarding || loading || !step2Done || !step3Done) return;
    setKV(`onboarding_done_${userId}_${businessId}`, '1').catch(() => {});
    setOnboardingDismissed(true);
  }, [showOnboarding, loading, step2Done, step3Done, userId, businessId]);

  useEffect(() => {
    if (showOnboarding && !loading) {
      const easing = Easing.inOut(Easing.sin);
      const loop = Animated.loop(
        Animated.sequence([
          Animated.parallel([
            Animated.timing(welcomeBtnScale,   { toValue: 1.06, duration: 2000, easing, useNativeDriver: true }),
            Animated.timing(welcomeBtnOpacity, { toValue: 0.85, duration: 2000, easing, useNativeDriver: true }),
          ]),
          Animated.parallel([
            Animated.timing(welcomeBtnScale,   { toValue: 1,    duration: 2000, easing, useNativeDriver: true }),
            Animated.timing(welcomeBtnOpacity, { toValue: 1,    duration: 2000, easing, useNativeDriver: true }),
          ]),
        ])
      );
      loop.start();
      return () => loop.stop();
    } else {
      welcomeBtnScale.setValue(1);
      welcomeBtnOpacity.setValue(1);
    }
  }, [showOnboarding, loading]);

  const loadAll = useCallback(async () => {
    if (!businessId) return;
    setIsOffline(false);
    setLoading(true);
    try {
      if (isInvestisseur) {
        await Promise.all([loadKpis(), loadBestSellers()]);
      } else {
        await Promise.all([fetchProducts(businessId, userId), loadKpis(), loadBestSellers()]);
      }
    } catch (err) {
      if (isNetworkError(err)) setIsOffline(true);
    } finally {
      setLoading(false);
    }
  }, [businessId, userId, isInvestisseur]);

  // Reload every time this tab gains focus (catches sales made in caisse)
  useFocusEffect(
    useCallback(() => {
      loadAll();
    }, [loadAll]),
  );

  const loadKpis = async () => {
    if (isInvestisseur) {
      const { data, error: kpiErr } = await supabase.rpc('get_business_kpis', { p_business_id: businessId });
      if (kpiErr) throw kpiErr;
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
    const firstErr = [todayRes, yestRes, monthRes, creditRes, expensesRes].find(r => r.error);
    if (firstErr?.error) {
      if (isNetworkError(firstErr.error)) {
        // Load snapshot from SQLite for historical numbers (yesterday, month, expenses)
        const cached = await getDashboardKpiCache(businessId) as KPIs | null;

        // Derive today's live numbers from ventes store (includes offline queued sales)
        const sales = useVentesStore.getState().sales;
        const todaySales = sales.filter(s => (s.sale_date ?? s.created_at.split('T')[0]) === today && s.status !== 'annule');
        const revenueToday = todaySales.filter(s => !s.is_credit).reduce((sum, s) => sum + s.total_amount, 0);
        const creditSales = sales.filter(s => s.status === 'credit');
        const creditTotalOffline = creditSales.reduce((sum, s) => sum + (s.total_amount - (s.amount_paid ?? 0)), 0);
        const creditCountOffline = new Set(creditSales.map(s => s.customer_name).filter(Boolean)).size
          + creditSales.filter(s => !s.customer_name).length;

        setKpis({
          revenue_today: revenueToday,
          revenue_yesterday: cached?.revenue_yesterday ?? 0,
          revenue_month: cached?.revenue_month ?? 0,
          sales_today: todaySales.length,
          credit_total: creditTotalOffline,
          credit_count: creditCountOffline,
          low_stock: lowStock,
          expenses_month: cached?.expenses_month ?? 0,
        });
        return;
      }
      throw firstErr.error;
    }

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

    const freshKpis: KPIs = {
      revenue_today: sum(todayRes.data as { total_amount: number }[] | null),
      revenue_yesterday: sum(yestRes.data as { total_amount: number }[] | null),
      revenue_month: sum(monthRes.data as { total_amount: number }[] | null),
      sales_today: todayRes.data?.length ?? 0,
      credit_total: creditTotal,
      credit_count: creditCount,
      low_stock: lowStock,
      expenses_month: sum(expensesRes.data as { amount: number }[] | null, 'amount'),
    };
    setKpis(freshKpis);
    void saveDashboardKpiCache(businessId, freshKpis);
  };

  const loadBestSellers = async () => {
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

    const { data, error: bsErr } = await supabase.rpc('get_best_sellers', {
      p_business_id: businessId,
      p_month_start: monthStart,
      p_limit:       5,
    });
    if (bsErr) throw bsErr;

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
      {isOffline && (
        <View style={styles.offlineBanner}>
          <Text variant="caption" color="secondary">Pas de réseau · Informations non actualisées</Text>
        </View>
      )}

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

        {/* Header */}
        <View style={styles.header}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Pressable onPress={openBusinessPicker} hitSlop={10} style={({ pressed }) => [{ opacity: pressed ? 0.5 : 1 }]}>
              <Ionicons name="menu" size={24} color="#111827" />
            </Pressable>
            <Text style={{ marginLeft: 12, fontSize: 18, fontWeight: '600', color: '#111827' }} numberOfLines={1}>
              {business?.name}
            </Text>
          </View>
          <Pressable
            onPress={() => router.push('/(app)/discussions')}
            style={({ pressed }) => [styles.chatBtn, { opacity: pressed ? 0.7 : 1 }]}
          >
            <Ionicons name="chatbubbles-outline" size={24} color={palette.textSecondary} />
            {totalUnread > 0 && (
              <View style={styles.chatBadge}>
                <Text style={styles.chatBadgeText}>{totalUnread > 99 ? '99+' : String(totalUnread)}</Text>
              </View>
            )}
          </Pressable>
        </View>

        {loading ? (
          <Text variant="body" color="secondary" style={{ textAlign: 'center', marginTop: spacing[6] }}>
            Chargement…
          </Text>
        ) : showOnboarding ? (
          /* ── Onboarding tracker: persisted flag, never re-shows once dismissed ── */
          <Card style={styles.onboarding}>
            <OnboardingStep number={1} label="Votre commerce a été créé" done                      active={false} />
            <OnboardingStep number={2} label="Ajouter un produit"        done={step2Done}            active={!step2Done} />
            <OnboardingStep number={3} label="Faire une vente"           done={step3Done}            active={step2Done && !step3Done} />
            <Animated.View style={{ width: '100%', marginTop: spacing[4], opacity: welcomeBtnOpacity, transform: [{ scale: welcomeBtnScale }] }}>
              <Button
                label={!step2Done ? 'Ajouter un produit' : 'Faire une vente'}
                onPress={() => !step2Done
                  ? router.push({ pathname: '/(app)/(tabs)/catalogue', params: { openForm: '1' } })
                  : router.push('/(app)/(tabs)/vendre')
                }
                fullWidth
                size="lg"
              />
            </Animated.View>
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
                  Hier vous avez fait {fmt(kpis?.revenue_yesterday ?? 0, currency)}
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
  header: { paddingBottom: spacing[2], flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  chatBtn: { padding: spacing[1] },
  chatBadge: {
    position: 'absolute', top: -2, right: -2,
    minWidth: 16, height: 16, borderRadius: radius.full,
    backgroundColor: palette.danger,
    alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 3,
  },
  chatBadgeText: { fontSize: 9, fontWeight: '700' as const, color: palette.textInverse, lineHeight: 12 },

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

  // Offline banner — slim ambient strip, Jony Ive: barely there, no action needed
  offlineBanner: {
    alignItems: 'center', justifyContent: 'center',
    paddingVertical: spacing[1],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.border,
  },

  // Welcome state
  welcome: { alignItems: 'center', gap: spacing[4], paddingVertical: spacing[8], paddingHorizontal: spacing[6] },
  welcomeEmoji: { fontSize: 52, lineHeight: 72 },
  onboarding: { gap: spacing[2], paddingVertical: spacing[6], paddingHorizontal: spacing[5] },
  onboardingStep: { flexDirection: 'row', alignItems: 'center', gap: spacing[3], paddingVertical: spacing[2] },
  onboardingBubble: { width: 32, height: 32, borderRadius: radius.full, borderWidth: 1.5, borderColor: palette.border, alignItems: 'center', justifyContent: 'center' },
  onboardingBubbleDone: { backgroundColor: palette.success, borderColor: palette.success },
  onboardingBubbleActive: { backgroundColor: palette.primary, borderColor: palette.primary },

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
