import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Linking, Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { Screen } from '@/src/components/ui/Screen';
import { router, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Button } from '@/src/components/ui/Button';
import { Card } from '@/src/components/ui/Card';
import { Text } from '@/src/components/ui/Text';
import { useTheme, radius, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useProductStore } from '@/stores/products';
import { useVentesStore } from '@/stores/ventes';
import { useChatStore } from '@/stores/chat';
import { useRapportsStore } from '@/stores/rapports';
import { useEquipeStore } from '@/stores/equipe';
import { useInvestorStore } from '@/stores/investor';
import type { MemberProductStake } from '@/src/types';
import { formatAmount, formatAmountInput, parseAmountInput } from '@/src/utils/format';
import { supabase } from '@/lib/supabase';
import { isNetworkError } from '@/lib/sync';
import { saveDashboardKpiCache, getDashboardKpiCache, getKV, setKV } from '@/lib/db';
import { SkeletonKpiGrid } from '@/src/components/ui/SkeletonPlaceholder';
import { haptics } from '@/lib/haptics';
import { toast } from '@/stores/toast';


const SUPPORT_WA_URL = `https://wa.me/16094454809?text=${encodeURIComponent("Bonjour ! J'ai une question sur Patron 🙂")}`;

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
  return `${Math.round(n).toLocaleString('fr-FR')} ${cur}`;
}

type DayPart = 'morning' | 'active' | 'evening' | 'night';

function getDayPart(): DayPart {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'active';
  if (h >= 17 && h < 21) return 'evening';
  return 'night';
}

function KpiCard({ label, value, sub, onPress, accent }: {
  label: string; value: string; sub?: string; onPress?: () => void; accent?: string;
}) {
  return (
    <Card onPress={onPress} style={[{ gap: spacing[1] }, accent ? { borderLeftWidth: 3, borderLeftColor: accent } : null]}>
      <Text variant="caption" color="secondary">{label}</Text>
      <Text variant="amountLarge" style={accent ? { color: accent } : undefined}>{value}</Text>
      {sub ? <Text variant="caption" color="secondary">{sub}</Text> : null}
    </Card>
  );
}

function OnboardingStep({ number, label, done, active }: {
  number: number; label: string; done: boolean; active: boolean;
}) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
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
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const session = useAuthStore(s => s.session);
  const openBusinessPicker = useAuthStore(s => s.openBusinessDrawer);
  const business = session?.activeBusiness;
  const role = session?.activeMembership?.role;
  const isInvestisseur = role === 'investisseur';
  const isVendeur = role === 'vendeur';
  const businessId = business?.id ?? '';
  const userId = session?.user.id ?? '';
  const membershipId = session?.activeMembership?.id ?? '';
  const currency = business?.currency ?? 'GNF';
  const memberships = session?.memberships ?? [];
  const totalUnread = useChatStore(s => s.boutiqueUnread + s.marcheUnread);

  const { products, fetchProducts } = useProductStore();
  const { snapshot: rapportsSnapshot, fetchReportsSnapshot } = useRapportsStore();
  const { fetchMemberScope } = useEquipeStore();
  const { balance, payouts, saving: investorSaving, fetchBalance, fetchPayouts, requestPayout } = useInvestorStore();
  const [kpis, setKpis] = useState<KPIs | null>(null);
  const [bestSellers, setBestSellers] = useState<BestSeller[]>([]);
  const [loading, setLoading] = useState(true);
  const [isOffline, setIsOffline] = useState(false);
  const [investorScope, setInvestorScope] = useState<MemberProductStake[]>([]);

  // Withdrawal sheet
  const [showWithdrawSheet, setShowWithdrawSheet] = useState(false);
  const [withdrawAmountStr, setWithdrawAmountStr] = useState('');

  const welcomeBtnScale = useRef(new Animated.Value(1)).current;
  const welcomeBtnOpacity = useRef(new Animated.Value(1)).current;
  const loadedForRef = useRef<string | null>(null);

  const isOwner = !isInvestisseur && !isVendeur;

  // null = not yet checked, true = dismissed, false = active
  const [onboardingDismissed, setOnboardingDismissed] = useState<boolean | null>(null);
  const [showCarnetSheet, setShowCarnetSheet] = useState(false);
  const [isPrivate, setIsPrivate] = useState(false);

  // Helpers: when privacy mode is on, replace money amounts with bullets
  const amtOrMask = (n: number) => isPrivate ? `••••• ${currency}` : fmt(n, currency);
  const rawOrMask = (n: number) => isPrivate ? '•••••' : n.toLocaleString('fr-FR');

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

  // Show carnet import sheet once — but only AFTER the onboarding steps card is gone.
  // Showing both simultaneously creates visual clutter and confuses new users.
  useEffect(() => {
    if (!userId || !businessId || !isOwner) return;
    if (session?.isDemoMode) return;
    if (onboardingDismissed !== true) return; // wait until step card is fully done
    const ageMs = business?.created_at ? Date.now() - new Date(business.created_at).getTime() : Infinity;
    if (ageMs > 7 * 24 * 60 * 60 * 1000) return;
    const key = `carnet_prompt_seen_${userId}_${businessId}`;
    getKV(key).then(val => {
      if (val !== null) return;
      void setKV(key, '1');
      setShowCarnetSheet(true);
    }).catch(() => {});
  }, [userId, businessId, isOwner, business?.created_at, onboardingDismissed]);

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
    if (loadedForRef.current !== businessId) {
      // Show skeleton immediately when switching businesses so stale data
      // from the previous business never shows alongside new-business content.
      setLoading(true);
      setBestSellers([]);
      setKpis(null);
      const cachedKpis = await getDashboardKpiCache(businessId) as KPIs | null;
      if (cachedKpis) {
        setKpis(cachedKpis);
        setLoading(false);
      }
    }
    const today = new Date();
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const daysThisMonth = Math.max(1, Math.floor((today.getTime() - monthStart.getTime()) / 86_400_000));
    void fetchReportsSnapshot(businessId, daysThisMonth, role ?? 'administrateur', userId);
    try {
      await Promise.all([fetchProducts(businessId, userId, membershipId, role), loadKpis(), loadBestSellers()]);
      if (isInvestisseur && membershipId) {
        fetchMemberScope(membershipId).then(rows => setInvestorScope(rows)).catch(() => {});
        fetchBalance(businessId, userId);
        fetchPayouts(businessId, userId);
      }
    } catch (err) {
      if (isNetworkError(err)) setIsOffline(true);
    } finally {
      setLoading(false);
      loadedForRef.current = businessId;
    }
  }, [businessId, userId, isInvestisseur, membershipId, role]);

  // Reload every time this tab gains focus (catches sales made in caisse)
  useFocusEffect(
    useCallback(() => {
      loadAll();
    }, [loadAll]),
  );

  const loadKpis = async () => {
    const localDate = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD device local date
    const { data, error } = await supabase.rpc('get_dashboard_kpis', {
      p_business_id: businessId,
      p_today:       localDate,
    });

    if (error) {
      if (isNetworkError(error)) {
        // Offline fallback: serve last cached snapshot + derive today from local store
        const cached = await getDashboardKpiCache(businessId) as KPIs | null;
        const now = new Date();
        const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        const sales = useVentesStore.getState().sales;
        const todaySales = sales.filter(s => (s.sale_date ?? s.created_at.split('T')[0]) === today && s.status !== 'annule');
        const creditSales = sales.filter(s => s.status === 'credit');
        const { products: pOffline, variantsByProduct: vOffline } = useProductStore.getState();
        setKpis({
          revenue_today: todaySales.filter(s => !s.is_credit).reduce((sum, s) => sum + s.total_amount - (s.discount_amount ?? 0), 0),
          revenue_yesterday: cached?.revenue_yesterday ?? 0,
          revenue_month:     cached?.revenue_month     ?? 0,
          sales_today:       todaySales.length,
          credit_total:      creditSales.reduce((sum, s) => sum + (s.total_amount - (s.discount_amount ?? 0) - (s.amount_paid ?? 0)), 0),
          credit_count:      new Set(creditSales.map(s => s.customer_name).filter(Boolean)).size + creditSales.filter(s => !s.customer_name).length,
          low_stock:         pOffline.filter(p => !p.has_variants && p.reorder_level > 0 && p.stock_qty <= p.reorder_level).length
                             + Object.values(vOffline).flat().filter(v => v.reorder_level > 0 && v.stock_qty <= v.reorder_level).length,
          expenses_month:    cached?.expenses_month    ?? 0,
        });
        return;
      }
      throw error;
    }

    const d = data as Record<string, number>;
    const freshKpis: KPIs = {
      revenue_today:     d.revenue_today     / 100,
      revenue_yesterday: d.revenue_yesterday / 100,
      revenue_month:     d.revenue_month     / 100,
      sales_today:       d.sales_today,
      credit_total:      d.credit_total      / 100,
      credit_count:      d.credit_count,
      low_stock:         d.low_stock,
      expenses_month:    d.expenses_month    / 100,
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
      (data ?? [])
        .map((r: BestSeller) => ({
          product_id:    r.product_id,
          product_name:  r.product_name,
          total_qty:     Number(r.total_qty),
          total_revenue: Number(r.total_revenue) / 100,
        }))
        .filter((bs: BestSeller) => bs.total_qty >= 2),
    );
  };

  const lowStock = kpis?.low_stock ?? 0;

  const visibleBestSellers = useMemo(() => {
    const archivedIds = new Set(products.filter(p => p.archived).map(p => p.id));
    if (isInvestisseur && investorScope.length > 0) {
      const scopeIds = new Set(investorScope.map(s => s.product_id));
      return bestSellers.filter(bs => scopeIds.has(bs.product_id) && !archivedIds.has(bs.product_id));
    }
    return bestSellers.filter(bs => !archivedIds.has(bs.product_id));
  }, [bestSellers, products, isInvestisseur, investorScope]);

  // Investor gain: sum profit_share% of each assigned product's gross margin this month.
  // Gross margin per product = revenue - (qty sold × cost_price). Expenses are business-level
  // overhead and are not deducted here since the stake is in individual product margins.
  const investorGain = useMemo(() => {
    if (!investorScope.length) return 0;
    return investorScope.reduce((total, stake) => {
      if (stake.profit_share <= 0) return total;
      const bs = bestSellers.find(b => b.product_id === stake.product_id);
      if (!bs) return total;
      const product = products.find(p => p.id === stake.product_id);
      const costPrice = product?.cost_price ?? 0;
      const productProfit = bs.total_revenue - bs.total_qty * costPrice;
      return total + (stake.profit_share / 100) * productProfit;
    }, 0);
  }, [investorScope, bestSellers, products]);

  const pendingPayout = payouts.find(p => p.status === 'en_attente');

  const monthNet        = rapportsSnapshot?.net_profit        ?? 0;
  const monthOrderCount = rapportsSnapshot?.period_order_count ?? 0;

  const salesCount = kpis?.sales_today ?? 0;
  const delta = (kpis?.revenue_today ?? 0) - (kpis?.revenue_yesterday ?? 0);
  const deltaColor = delta > 0 ? palette.success : delta < 0 ? palette.warning : palette.textSecondary;
  const showAttentionCards = (kpis?.credit_count ?? 0) > 0 || lowStock > 0;

  const dayPart = getDayPart();
  const dayGreeting = dayPart === 'morning' ? 'Bonne journée'
    : dayPart === 'evening' ? 'Voici votre journée'
    : null;
  const heroCaption = dayPart === 'morning'
    ? `Bonjour · ${salesCount} vente${salesCount !== 1 ? 's' : ''}`
    : dayPart === 'evening'
    ? `Ce soir · ${salesCount} vente${salesCount !== 1 ? 's' : ''}`
    : `Aujourd'hui · ${salesCount} vente${salesCount !== 1 ? 's' : ''}`;

  const isEvening = dayPart === 'evening' || dayPart === 'night';
  const deltaAmt = isPrivate ? `••••• ${currency}` : fmt(Math.abs(delta), currency);
  const comparisonText = isEvening
    ? `Ce mois : ${amtOrMask(kpis?.revenue_month ?? 0)}`
    : delta > 0 ? `↑ ${deltaAmt} de plus qu'hier`
    : delta < 0 ? `↓ ${deltaAmt} de moins qu'hier`
    : "Même niveau qu'hier";

  return (
    <Screen tab>
      {/* One-time carnet import sheet shown after business creation */}
      <Modal visible={showCarnetSheet} transparent animationType="slide" onRequestClose={() => setShowCarnetSheet(false)}>
        <View style={styles.sheetBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowCarnetSheet(false)} />
          <View style={[styles.sheetPanel, { backgroundColor: palette.surface }]}>
            <View style={[styles.sheetHandle, { backgroundColor: palette.border }]} />
            <Text variant="h3" style={styles.sheetTitle}>Votre commerce est créé !</Text>
            <Text variant="body" color="secondary" style={styles.sheetBody}>
              Des gens vous doivent de l'argent ?
            </Text>
            <Button
              label="Oui, les noter →"
              size="lg"
              fullWidth
              onPress={() => {
                setShowCarnetSheet(false);
                router.push('/(app)/onboarding/carnet');
              }}
              style={{ marginTop: spacing[2] }}
            />
            <Button
              label="Pas maintenant"
              variant="ghost"
              fullWidth
              onPress={() => setShowCarnetSheet(false)}
            />
          </View>
        </View>
      </Modal>

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
              <Ionicons name="menu" size={24} color={palette.textPrimary} />
            </Pressable>
            <Text variant="h4" style={{ marginLeft: 12 }} numberOfLines={1}>
              {business?.name}
            </Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}>
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
        </View>

        {loading ? (
          <SkeletonKpiGrid />
        ) : showOnboarding ? (
          /* ── Onboarding tracker: persisted flag, never re-shows once dismissed ── */
          <Card style={styles.onboarding}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing[2] }}>
              <Text variant="label" color="secondary">Pour commencer</Text>
              <Pressable
                hitSlop={12}
                onPress={() => {
                  setKV(`onboarding_done_${userId}_${businessId}`, '1').catch(() => {});
                  setOnboardingDismissed(true);
                }}
              >
                <Text variant="caption" color="secondary">Passer</Text>
              </Pressable>
            </View>
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

        ) : isInvestisseur ? (
          /* ── INVESTOR HOME ─────────────────────────────────────────────────── */
          <View style={{ gap: spacing[4] }}>

            {/* ── 1. Gains hero ── */}
            {pendingPayout ? (
              <Card style={[styles.heroCard, { backgroundColor: palette.warningLight }]}>
                <Text variant="caption" style={{ color: palette.warning }}>Demande en cours</Text>
                <Text variant="amountLarge" style={{ color: palette.warning, fontSize: 44, lineHeight: 56 }}>
                  {formatAmount(pendingPayout.requested_amount, currency)}
                </Text>
                <Text variant="caption" color="secondary" style={{ marginTop: spacing[1] }}>
                  en cours de traitement
                </Text>
              </Card>
            ) : (
              <Card style={styles.heroCard}>
                <View style={styles.investorHeroRow}>
                  <View style={{ flex: 1, gap: spacing[1] }}>
                    <Text variant="caption" color="secondary">Vos gains</Text>
                    <Text
                      variant="amountLarge"
                      style={{ color: (balance ?? 0) > 0 ? palette.success : palette.textPrimary, fontSize: 44, lineHeight: 56 }}
                    >
                      {formatAmount(balance ?? 0, currency)}
                    </Text>
                  </View>
                  {(balance ?? 0) > 0 && (
                    <Pressable
                      onPress={() => {
                        setWithdrawAmountStr(formatAmountInput(String(balance ?? 0)));
                        setShowWithdrawSheet(true);
                      }}
                      style={[styles.withdrawBtn, { borderColor: palette.primary }]}
                    >
                      <Text variant="label" style={{ color: palette.primary }}>Retirer</Text>
                    </Pressable>
                  )}
                </View>
                <View style={[styles.heroComparison, { marginTop: spacing[3] }]}>
                  <Text variant="caption" color="secondary">
                    {monthNet > 0
                      ? `Ce mois, bénéfice de ${formatAmount(monthNet, currency)} · ${monthOrderCount} vente${monthOrderCount !== 1 ? 's' : ''}`
                      : monthOrderCount > 0
                      ? `Ce mois · ${monthOrderCount} vente${monthOrderCount !== 1 ? 's' : ''}`
                      : 'Aucune vente ce mois'}
                  </Text>
                </View>
              </Card>
            )}

            {/* ── 2. Leurs produits ── */}
            {investorScope.length > 0 && (
              <View style={styles.section}>
                <Text variant="label" color="secondary" style={styles.sectionTitle}>
                  Vos produits
                </Text>
                {investorScope.map(stake => {
                  const bs      = bestSellers.find(b => b.product_id === stake.product_id);
                  const product = products.find(p => p.id === stake.product_id);
                  const cost    = product?.cost_price ?? 0;
                  const profit  = bs ? bs.total_revenue - bs.total_qty * cost : 0;
                  const gain    = (stake.profit_share / 100) * profit;
                  return (
                    <View key={stake.product_id} style={styles.bsRow}>
                      <Text variant="body" style={{ flex: 1 }} numberOfLines={1}>{stake.product_name}</Text>
                      <View style={{ alignItems: 'flex-end' }}>
                        {bs && bs.total_revenue > 0 ? (
                          <>
                            <Text variant="label" style={{ color: palette.success }}>
                              {formatAmount(gain, currency)}
                            </Text>
                            <Text variant="caption" color="secondary">
                              {stake.profit_share}% · {formatAmount(bs.total_revenue, currency)}
                            </Text>
                          </>
                        ) : (
                          <Text variant="caption" color="secondary">{stake.profit_share}% des bénéfices</Text>
                        )}
                      </View>
                    </View>
                  );
                })}
                {investorGain > 0 && (
                  <View style={[styles.bsRow, { borderBottomWidth: 0 }]}>
                    <Text variant="body" color="secondary" style={{ flex: 1 }}>Gain estimé ce mois</Text>
                    <Text variant="label" style={{ color: palette.success }}>
                      {formatAmount(investorGain, currency)}
                    </Text>
                  </View>
                )}
              </View>
            )}

          </View>

        ) : (
          <>
            {/* ── Zone 1: Hero — Today ── */}
            {dayGreeting ? (
              <Text variant="caption" color="secondary">{dayGreeting}</Text>
            ) : null}
            <Card onPress={() => router.push('/ventes')} style={styles.heroCard}>
              <Pressable
                onPress={() => setIsPrivate(p => !p)}
                style={styles.heroEye}
                hitSlop={12}
              >
                <Ionicons
                  name={isPrivate ? 'eye-off-outline' : 'eye-outline'}
                  size={18}
                  color={isPrivate ? palette.primary : palette.textSecondary}
                />
              </Pressable>
              <View style={styles.heroTop}>
                <Text variant="caption" color="secondary">
                  {heroCaption}
                </Text>
                <View style={styles.heroAmountRow}>
                  <Text
                    variant="amountLarge"
                    color={salesCount > 0 ? 'success' : undefined}
                    style={styles.heroAmount}
                  >
                    {rawOrMask(kpis?.revenue_today ?? 0)}
                  </Text>
                  <Text
                    variant="amountLarge"
                    color={salesCount > 0 ? 'success' : undefined}
                    style={styles.heroCurrency}
                  >
                    {currency}
                  </Text>
                </View>
              </View>
              <View style={styles.heroComparison}>
                <Text variant="caption" style={{ color: isEvening ? palette.textSecondary : deltaColor }}>
                  {comparisonText}
                </Text>
              </View>
            </Card>

            {/* ── Zone 2: Attention — conditional ── */}
            {showAttentionCards ? (
              <View style={styles.attentionZone}>
                {(kpis?.credit_count ?? 0) > 0 && (
                  <KpiCard
                    label={`${kpis?.credit_count} client${(kpis?.credit_count ?? 0) > 1 ? 's' : ''} qui doivent`}
                    value={amtOrMask(kpis?.credit_total ?? 0)}
                    onPress={() => router.push('/credits')}
                    accent={palette.warning}
                  />
                )}
                {lowStock > 0 && (
                  <KpiCard
                    label="À racheter"
                    value={String(lowStock)}
                    sub={`produit${lowStock > 1 ? 's' : ''} à racheter`}
                    onPress={isVendeur ? undefined : () => router.push('/(app)/(tabs)/catalogue')}
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
            {visibleBestSellers.length > 0 && (
              <View style={styles.section}>
                <Text variant="label" color="secondary" style={styles.sectionTitle}>
                  Produits qui marchent
                </Text>
                {visibleBestSellers.map((bs, i) => (
                  <View key={bs.product_id} style={styles.bsRow}>
                    <Text variant="caption" style={{ width: 20, color: palette.textSecondary }}>#{i + 1}</Text>
                    <Text variant="body" style={{ flex: 1 }} numberOfLines={1}>{bs.product_name}</Text>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text variant="label">{amtOrMask(bs.total_revenue)}</Text>
                      <Text variant="caption" color="secondary">{bs.total_qty} unité{bs.total_qty > 1 ? 's' : ''}</Text>
                    </View>
                  </View>
                ))}
              </View>
            )}


            {/* ── Zone 3: Month context — hidden in evening/night (already in comparison) ── */}
            {dayPart !== 'evening' && dayPart !== 'night' ? (
              <Text variant="caption" color="secondary" style={styles.monthLine}>
                Ce mois: {amtOrMask(kpis?.revenue_month ?? 0)}
              </Text>
            ) : null}
          </>
        )}
      </ScrollView>

      {/* ── Withdrawal sheet ── */}
      <Modal visible={showWithdrawSheet} transparent animationType="slide" onRequestClose={() => setShowWithdrawSheet(false)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setShowWithdrawSheet(false)}>
          <Pressable style={[styles.sheetPanel, { backgroundColor: palette.surface }]} onPress={() => {}}>
            <View style={[styles.sheetHandle, { backgroundColor: palette.border }]} />
            <Text variant="h4" style={styles.sheetTitle}>Retirer mes gains</Text>
            <Text variant="caption" color="secondary" style={styles.sheetBody}>
              Disponible : {formatAmount(balance ?? 0, currency)}
            </Text>

            {/* Amount input */}
            <View style={{ width: '100%', gap: spacing[2] }}>
              <Text variant="label">Montant à retirer</Text>
              <View style={[styles.withdrawInput, { borderColor: palette.border, backgroundColor: palette.background }]}>
                <TextInput
                  style={{ flex: 1, fontSize: 28, fontWeight: '700', color: palette.textPrimary }}
                  value={withdrawAmountStr}
                  onChangeText={v => setWithdrawAmountStr(formatAmountInput(v))}
                  keyboardType="numeric"
                  placeholder="0"
                  placeholderTextColor={palette.textDisabled}
                  selectTextOnFocus
                />
                <Text variant="label" color="secondary">{currency}</Text>
              </View>
            </View>

            <Button
              label={investorSaving ? 'Envoi…' : 'Envoyer la demande'}
              fullWidth
              size="lg"
              loading={investorSaving}
              onPress={async () => {
                const amt = parseAmountInput(withdrawAmountStr);
                if (!amt || amt <= 0) { toast.warning('Entrez un montant valide'); return; }
                const balanceVal = balance ?? 0;
                if (amt > balanceVal) { toast.warning('Montant supérieur à votre solde'); return; }
                const amtCents = BigInt(Math.round(amt * 100));
                const ok = await requestPayout(businessId, amtCents);
                if (ok) {
                  haptics.success();
                  toast.success('Demande envoyée');
                  setShowWithdrawSheet(false);
                  setWithdrawAmountStr('');
                }
              }}
            />
            <Pressable onPress={() => setShowWithdrawSheet(false)}>
              <Text variant="label" color="secondary">Annuler</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <Pressable
        style={styles.whatsappCorner}
        onPress={() => Linking.openURL(SUPPORT_WA_URL)}
        hitSlop={12}
      >
        <Ionicons name="logo-whatsapp" size={13} color={palette.textSecondary} />
        <Text variant="caption" color="secondary">Support</Text>
      </Pressable>
    </Screen>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: p.background },
    content: { padding: spacing[5], gap: spacing[4], paddingBottom: spacing[10] },
    header: { paddingBottom: spacing[2], flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    chatBtn: { padding: spacing[1] },
    chatBadge: {
      position: 'absolute', top: -2, right: -2,
      minWidth: 16, height: 16, borderRadius: radius.full,
      backgroundColor: p.danger,
      alignItems: 'center', justifyContent: 'center',
      paddingHorizontal: 3,
    },
    chatBadgeText: { fontSize: 9, fontWeight: '700' as const, color: p.textInverse, lineHeight: 12 },

    heroCard: {},
    investorHeroRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: spacing[4] },
    heroEye: {
      position: 'absolute' as const,
      top: spacing[3],
      right: spacing[3],
      padding: spacing[1],
      zIndex: 1,
    },
    heroTop: { gap: spacing[1] },
    heroAmountRow: { position: 'relative' },
    heroAmount: { fontSize: 52, lineHeight: 64 },
    heroCurrency: { fontSize: 18, lineHeight: 24, position: 'absolute', top: 4, right: 0 },
    heroComparison: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingTop: spacing[3],
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: p.border,
    },

    attentionZone: { gap: spacing[3] },
    allGood: { textAlign: 'center', paddingVertical: spacing[3] },
    monthLine: { textAlign: 'center', paddingVertical: spacing[2] },

    offlineBanner: {
      alignItems: 'center', justifyContent: 'center',
      paddingVertical: spacing[1],
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: p.border,
    },
    sheetBackdrop: {
      flex: 1, justifyContent: 'flex-end',
      backgroundColor: 'rgba(0,0,0,0.5)',
    },
    sheetPanel: {
      borderTopLeftRadius: 24, borderTopRightRadius: 24,
      paddingHorizontal: spacing[6],
      paddingTop: spacing[3],
      paddingBottom: spacing[10],
      alignItems: 'center',
      gap: spacing[3],
    },
    sheetHandle: {
      width: 40, height: 4, borderRadius: 2,
      marginBottom: spacing[2],
    },
    sheetTitle: { textAlign: 'center' },
    sheetBody:  { textAlign: 'center', lineHeight: 24 },

    welcome: { alignItems: 'center', gap: spacing[4], paddingVertical: spacing[8], paddingHorizontal: spacing[6] },
    welcomeEmoji: { fontSize: 52, lineHeight: 72 },
    onboarding: { gap: spacing[2], paddingVertical: spacing[6], paddingHorizontal: spacing[5] },
    onboardingStep: { flexDirection: 'row', alignItems: 'center', gap: spacing[3], paddingVertical: spacing[2] },
    onboardingBubble: { width: 32, height: 32, borderRadius: radius.full, borderWidth: 1.5, borderColor: p.border, alignItems: 'center', justifyContent: 'center' },
    onboardingBubbleDone: { backgroundColor: p.success, borderColor: p.success },
    onboardingBubbleActive: { backgroundColor: p.primary, borderColor: p.primary },

    section: {
      backgroundColor: p.surface,
      borderRadius: radius.card,
      borderWidth: 1,
      borderColor: p.border,
      overflow: 'hidden',
    },
    sectionTitle: {
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[3],
      borderBottomWidth: 1,
      borderBottomColor: p.border,
    },
    bsRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing[3],
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[3],
      borderBottomWidth: 1,
      borderBottomColor: p.border,
    },
    withdrawBtn: {
      borderWidth: 1.5, borderRadius: radius.full,
      paddingHorizontal: spacing[4], paddingVertical: spacing[2],
    },
    withdrawInput: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[3],
      borderWidth: 1, borderRadius: radius.md,
      paddingHorizontal: spacing[4], paddingVertical: spacing[3],
    },
    whatsappCorner: {
      position: 'absolute',
      bottom: 12,
      right: spacing[3],
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing[1],
    },
  });
}
