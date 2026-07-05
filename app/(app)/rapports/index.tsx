import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Screen } from '@/src/components/ui/Screen';
import { router } from 'expo-router';
import { Card } from '@/src/components/ui/Card';
import { SkeletonKpiGrid } from '@/src/components/ui/SkeletonPlaceholder';
import { OfflineNotice } from '@/src/components/ui/OfflineNotice';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing, radius } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useRapportsStore } from '@/stores/rapports';

function fmt(n: number, cur: string) {
  return `${Math.round(n).toLocaleString('fr-FR')} ${cur}`;
}

type Period = 'semaine' | 'mois' | 'trimestre';
const PERIOD_DAYS: Record<Period, number> = { semaine: 7, mois: 30, trimestre: 90 };

const PERIOD_SENTENCE: Record<Period, string> = {
  semaine:   'Cette semaine, votre bénéfice est de',
  mois:      'Ce mois, votre bénéfice est de',
  trimestre: 'Ce trimestre, votre bénéfice est de',
};
const PERIOD_SELLER: Record<Period, string> = { semaine: 'de la semaine', mois: 'du mois', trimestre: 'du trimestre' };
const PERIOD_BOUTIQUE: Record<Period, string> = { semaine: 'cette semaine', mois: 'ce mois', trimestre: 'ce trimestre' };
const PERIOD_VENDEUR_SENTENCE: Record<Period, string> = {
  semaine:   'Cette semaine, vous avez vendu pour',
  mois:      'Ce mois, vous avez vendu pour',
  trimestre: 'Ce trimestre, vous avez vendu pour',
};

// ── Pulse skeleton ─────────────────────────────────────────────────────────────

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

// ── Mini stat card ─────────────────────────────────────────────────────────────

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

// ── Days badge ─────────────────────────────────────────────────────────────────

function DaysBadge({ days }: { days: number | null }) {
  const { palette } = useTheme();
  if (days === null) return null;
  const isRupture = days <= 0;
  const isCritique = days > 0 && days <= 7;
  const bg    = isRupture || isCritique ? palette.warningLight : palette.successLight;
  const color = isRupture || isCritique ? palette.warning : palette.success;
  const label = isRupture ? 'Épuisé' : days === 1 ? '~1 jour' : `~${days}j`;
  return (
    <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, backgroundColor: bg }}>
      <Text style={{ fontSize: 12, fontWeight: '700' as const, color }}>{label}</Text>
    </View>
  );
}

// ── Section separator ──────────────────────────────────────────────────────────

function SectionSep({ label }: { label: string }) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  return (
    <View style={styles.sectionSep}>
      <View style={styles.sectionSepLine} />
      <Text style={styles.sectionSepLabel}>{label}</Text>
      <View style={styles.sectionSepLine} />
    </View>
  );
}

// ── Main screen ────────────────────────────────────────────────────────────────

export default function RapportsScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const session      = useAuthStore(s => s.session);
  const businessId   = session?.activeBusiness?.id ?? '';
  const businessName = session?.activeBusiness?.name ?? 'La boutique';
  const userId       = session?.user.id ?? '';
  const currency     = session?.activeBusiness?.currency ?? 'GNF';
  const role           = session?.activeMembership?.role;
  const isInvestisseur = role === 'investisseur';
  const isVendeur      = role === 'vendeur';

  const {
    snapshot, snapshotLoading, offline, offlineSince,
    stockVelocity,
    fetchReportsSnapshot, fetchStockVelocity,
  } = useRapportsStore();

  const [period, setPeriod] = useState<Period>('mois');

  useEffect(() => {
    if (!businessId || !role) return;
    fetchReportsSnapshot(businessId, PERIOD_DAYS[period], role, userId);
    if (role !== 'investisseur' && role !== 'vendeur') {
      fetchStockVelocity(businessId);
    }
  }, [businessId, role, userId, period]);

  // ── Snapshot values (display units, already ÷100 by the store) ────────────
  const revenue            = snapshot?.revenue            ?? 0;
  const netProfit          = snapshot?.net_profit         ?? 0;
  const operExpenses       = snapshot?.operating_expenses ?? 0;
  const shippingExp        = snapshot?.shipping_expenses  ?? 0;
  const creditOutstanding  = snapshot?.credit_outstanding ?? 0;
  const creditCount        = snapshot?.credit_count       ?? 0;
  const periodOrderCount   = snapshot?.period_order_count ?? 0;
  const cashOnHand         = snapshot?.cash_on_hand       ?? 0;
  const stockValue         = snapshot?.stock_value        ?? 0;
  const totalApports       = snapshot?.total_apports      ?? 0;
  const periodApports      = snapshot?.period_apports     ?? 0;
  const topSellers         = snapshot?.top_sellers        ?? [];
  const hasMultipleSellers = topSellers.length > 1;

  const myRevenue       = snapshot?.my_revenue       ?? 0;
  const mySalesCount    = snapshot?.my_sales_count   ?? 0;
  const myCreditPending = snapshot?.my_credit_pending ?? 0;
  const myCreditCount   = snapshot?.my_credit_count   ?? 0;

  const investorBalance  = snapshot?.investor_balance  ?? 0;
  const myTotalInvested  = snapshot?.my_total_invested  ?? 0;
  const myPeriodApports  = snapshot?.my_period_apports  ?? 0;
  const roi = myTotalInvested > 0 && investorBalance > 0
    ? ((investorBalance / myTotalInvested) * 100)
    : null;

  // ── Stock velocity — critical items only (< 14 days or rupture) ──────────────
  const criticalStock = useMemo(
    () => stockVelocity.filter(i => i.days_remaining !== null && i.days_remaining < 14).slice(0, 6),
    [stockVelocity],
  );

  // ── Chart buckets from daily activity (display logic only, not financial math) ─
  const chartBuckets = useMemo(() => {
    const activity = snapshot?.activity ?? [];
    if (period === 'trimestre') {
      const today = new Date();
      const buckets: { key: string; label: string; val: number }[] = [];
      for (let w = 12; w >= 0; w--) {
        const d = new Date(today); d.setDate(today.getDate() - w * 7);
        buckets.push({ key: `w${w}`, label: w === 0 ? 'Récent' : `${d.getDate()}/${d.getMonth() + 1}`, val: 0 });
      }
      for (const pt of activity) {
        const daysAgo = Math.floor((today.getTime() - new Date(pt.date).getTime()) / 86_400_000);
        const idx = 12 - Math.min(Math.floor(daysAgo / 7), 12);
        if (idx >= 0) buckets[idx].val += pt.amount;
      }
      return buckets;
    }
    return activity.map(pt => ({
      key:   pt.date,
      label: period === 'semaine' ? new Date(pt.date).toLocaleDateString('fr-FR', { weekday: 'short' }) : '',
      val:   pt.amount,
    }));
  }, [snapshot?.activity, period]);
  const maxBar = Math.max(...chartBuckets.map(b => b.val), 1);

  const sellerChartBuckets = useMemo(() => {
    const activity = snapshot?.my_activity ?? [];
    if (period === 'trimestre') {
      const today = new Date();
      const buckets: { key: string; label: string; val: number }[] = [];
      for (let w = 12; w >= 0; w--) {
        const d = new Date(today); d.setDate(today.getDate() - w * 7);
        buckets.push({ key: `w${w}`, label: w === 0 ? 'Récent' : `${d.getDate()}/${d.getMonth() + 1}`, val: 0 });
      }
      for (const pt of activity) {
        const daysAgo = Math.floor((today.getTime() - new Date(pt.date).getTime()) / 86_400_000);
        const idx = 12 - Math.min(Math.floor(daysAgo / 7), 12);
        if (idx >= 0) buckets[idx].val += pt.amount;
      }
      return buckets;
    }
    return activity.map(pt => ({
      key:   pt.date,
      label: period === 'semaine' ? new Date(pt.date).toLocaleDateString('fr-FR', { weekday: 'short' }) : '',
      val:   pt.amount,
    }));
  }, [snapshot?.my_activity, period]);
  const sellerMaxBar = Math.max(...sellerChartBuckets.map(b => b.val), 1);

  const periodToggle = (
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
  );

  const activityChart = (
    <Card style={{ gap: spacing[3] }}>
      <Text style={styles.sectionTitle}>Activité</Text>
      <View style={styles.barsRow}>
        {chartBuckets.map((b, i) => (
          <View key={b.key ?? i} style={styles.barWrap}>
            <View style={[styles.bar, { height: Math.max(4, (b.val / maxBar) * 72) }]} />
            {period === 'semaine' && (
              <Text style={styles.barLabel} numberOfLines={1}>{b.label}</Text>
            )}
          </View>
        ))}
      </View>
    </Card>
  );

  const sellerActivityChart = (
    <Card style={{ gap: spacing[3] }}>
      <Text style={styles.sectionTitle}>Activité</Text>
      <View style={styles.barsRow}>
        {sellerChartBuckets.map((b, i) => (
          <View key={b.key ?? i} style={styles.barWrap}>
            <View style={[styles.bar, { height: Math.max(4, (b.val / sellerMaxBar) * 72) }]} />
            {period === 'semaine' && (
              <Text style={styles.barLabel} numberOfLines={1}>{b.label}</Text>
            )}
          </View>
        ))}
      </View>
    </Card>
  );

  // Show the skeleton for the entire duration of any fetch — including a
  // period-tab switch, not just the very first load. Rendering the previous
  // period's snapshot while a new one is in flight is what caused stale
  // day counts / bar labels to flash briefly before snapping to the right
  // period's data.
  if (snapshotLoading) {
    return (
      <Screen>
        <View style={styles.hdr}>
          <Pressable onPress={() => router.back()}>
            <Text variant="body" color="secondary">‹ Retour</Text>
          </Pressable>
          <Text variant="h4">{isInvestisseur ? businessName : 'Mes chiffres'}</Text>
          <View style={{ width: 60 }} />
        </View>
        <View style={styles.content}>
          {periodToggle}
        </View>
        <SkeletonKpiGrid />
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={styles.hdr}>
        <Pressable onPress={() => router.back()}>
          <Text variant="body" color="secondary">‹ Retour</Text>
        </Pressable>
        <Text variant="h4">{isInvestisseur ? businessName : 'Mes chiffres'}</Text>
        <View style={{ width: 60 }} />
      </View>

      {offline && <OfflineNotice offlineSince={offlineSince} />}

      {/* ════════════════════════════════════════════════════════════════════════
          VENDEUR VIEW
          ════════════════════════════════════════════════════════════════════ */}
      {isVendeur ? (
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          {periodToggle}

          {/* ── 1. Hero: ventes personnelles ──────────────────────────────── */}
          <Card style={styles.hero}>
            <Text style={styles.heroCaption}>{PERIOD_VENDEUR_SENTENCE[period]}</Text>
            <Text style={[styles.heroAmount, { color: palette.success }]}>
              {fmt(myRevenue, currency)}
            </Text>
            {mySalesCount > 0 ? (
              <Text style={styles.heroSub}>
                sur {mySalesCount} vente{mySalesCount !== 1 ? 's' : ''}
              </Text>
            ) : (
              <Text style={styles.heroSub}>Aucune vente sur cette période</Text>
            )}
          </Card>

          {/* ── 2. Activité personnelle ────────────────────────────────────── */}
          {sellerActivityChart}

          {/* ── 3. Crédits en attente ─────────────────────────────────────── */}
          {myCreditPending > 0 && (
            <StatCard
              label="Crédits en attente"
              value={fmt(myCreditPending, currency)}
              accent={palette.warning}
              bg={palette.warningLight}
              note={`${myCreditCount} commande${myCreditCount > 1 ? 's' : ''} en cours`}
            />
          )}
        </ScrollView>

      /* ════════════════════════════════════════════════════════════════════════
         INVESTISSEUR VIEW
         ════════════════════════════════════════════════════════════════════ */
      ) : isInvestisseur ? (
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

          {/* ── 1. Hero: ROI si bénéfice, sinon mise totale ───────────────── */}
          {roi !== null && roi > 0 ? (
            <Card style={styles.hero}>
              <Text style={styles.heroCaption}>Votre investissement rapporte actuellement</Text>
              <Text style={[styles.heroAmount, { color: palette.success }]}>
                {roi.toFixed(1)}%
              </Text>
              <Text style={styles.heroSub}>
                soit {fmt(investorBalance, currency)} de bénéfice
              </Text>
            </Card>
          ) : (
            <Card style={[styles.hero, { backgroundColor: palette.primaryLight }]}>
              <Text style={[styles.heroCaption, { color: palette.primary }]}>
                Vous avez investi dans {businessName}
              </Text>
              <Text style={[styles.heroAmount, { color: palette.primary }]}>
                {fmt(myTotalInvested, currency)}
              </Text>
              <Text style={[styles.heroSub, { color: palette.primary }]}>
                bénéfice en cours
              </Text>
            </Card>
          )}

          {/* ── 2. Période ────────────────────────────────────────────────── */}
          {periodToggle}

          {/* ── 3. Santé de la boutique sur la période ────────────────────── */}
          <StatCard
            label={`Bénéfice de la boutique ${PERIOD_BOUTIQUE[period]}`}
            value={fmt(netProfit, currency)}
            accent={netProfit >= 0 ? palette.success : palette.warning}
            bg={netProfit >= 0 ? palette.successLight : palette.warningLight}
            note={periodOrderCount > 0
              ? `${periodOrderCount} vente${periodOrderCount !== 1 ? 's' : ''}`
              : 'Aucune vente'}
          />

          {/* ── 4. Activité ───────────────────────────────────────────────── */}
          {activityChart}

          {/* ── Separator ─────────────────────────────────────────────────── */}
          <SectionSep label="Votre mise" />

          {/* ── 5. Investissement personnel ───────────────────────────────── */}
          <StatCard
            label={`Vous avez mis dans ${businessName}`}
            value={fmt(myTotalInvested, currency)}
            accent={palette.primary}
            bg={palette.primaryLight}
            note={myPeriodApports > 0
              ? `dont ${fmt(myPeriodApports, currency)} ${PERIOD_BOUTIQUE[period]}`
              : undefined}
          />

        </ScrollView>

      /* ════════════════════════════════════════════════════════════════════════
         ADMIN / MANAGER VIEW
         ════════════════════════════════════════════════════════════════════ */
      ) : (
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          {periodToggle}

          {/* ── 1. Hero: bénéfice net ──────────────────────────────────────── */}
          <Card style={styles.hero}>
            <Text style={styles.heroCaption}>{PERIOD_SENTENCE[period]}</Text>
            <Text style={[styles.heroAmount, { color: netProfit >= 0 ? palette.success : palette.warning }]}>
              {fmt(netProfit, currency)}
            </Text>
            {periodOrderCount > 0 ? (
              <Text style={styles.heroSub}>
                sur {periodOrderCount} vente{periodOrderCount !== 1 ? 's' : ''}
              </Text>
            ) : (
              <Text style={styles.heroSub}>Aucune vente sur cette période</Text>
            )}
          </Card>

          {/* ── 2. Dépenses — only if > 0 ─────────────────────────────────── */}
          {operExpenses > 0 && (
            <StatCard
              label="Dépenses"
              value={fmt(operExpenses, currency)}
              accent={palette.warning}
              bg={palette.warningLight}
            />
          )}

          {/* ── 3. Frais de transport — only if > 0 ───────────────────────── */}
          {shippingExp > 0 && (
            <StatCard
              label="Frais de transport"
              value={fmt(shippingExp, currency)}
              accent={palette.textSecondary}
              bg={palette.surface}
              note="Déjà inclus dans votre coût de revient"
            />
          )}

          {/* ── 4. Crédits en attente — only if > 0 ───────────────────────── */}
          {creditOutstanding > 0 && (
            <StatCard
              label="Crédits en attente"
              value={fmt(creditOutstanding, currency)}
              accent={palette.warning}
              bg={palette.warningLight}
              note={`${creditCount} commande${creditCount > 1 ? 's' : ''} en cours`}
            />
          )}

          {/* ── 5. Stock critique — only if items < 14 days or rupture ───────── */}
          {criticalStock.length > 0 && (
            <Card style={{ gap: spacing[3] }}>
              <Text style={styles.sectionTitle}>Stock critique</Text>
              {criticalStock.map(item => (
                <View key={item.item_id} style={styles.listRow}>
                  <Text variant="body" style={{ flex: 1 }} numberOfLines={1}>{item.item_name}</Text>
                  <DaysBadge days={item.days_remaining} />
                </View>
              ))}
            </Card>
          )}

          {/* ── 6. Activité ───────────────────────────────────────────────────── */}
          {activityChart}

          {/* ── 7. Vendeurs — only if team ────────────────────────────────────── */}
          {hasMultipleSellers && topSellers.length > 0 && (
            <Card style={{ gap: spacing[3] }}>
              <Text style={styles.sectionTitle}>Vendeurs {PERIOD_SELLER[period]}</Text>
              {topSellers.map((seller, i) => {
                const pct = revenue > 0 ? (seller.revenue / revenue) * 100 : 0;
                return (
                  <View key={seller.name} style={{ gap: spacing[1] }}>
                    <View style={styles.listRow}>
                      <Text variant="caption" style={{ width: 18, color: palette.textSecondary }}>#{i + 1}</Text>
                      <Text variant="body" style={{ flex: 1 }} numberOfLines={1}>{seller.name}</Text>
                      <Text variant="caption" color="secondary">{fmt(seller.revenue, currency)}</Text>
                    </View>
                    <View style={styles.barTrack}>
                      <View style={[styles.barFill, { width: `${pct}%` as unknown as number }]} />
                    </View>
                  </View>
                );
              })}
            </Card>
          )}

          {/* ── Separator ─────────────────────────────────────────────────────── */}
          <SectionSep label="Votre boutique" />

          {/* ── 8. Valeur du stock + Argent disponible ────────────────────────── */}
          <View style={styles.gridRow}>
            <StatCard
              label="Valeur du stock"
              value={fmt(stockValue, currency)}
              accent={palette.primary}
              bg={palette.primaryLight}
            />
            <StatCard
              label="Argent disponible"
              value={fmt(cashOnHand, currency)}
              accent={cashOnHand >= 0 ? palette.primary : palette.warning}
              bg={cashOnHand >= 0 ? palette.primaryLight : palette.warningLight}
            />
          </View>

          {/* ── 9. Capital — only if any ──────────────────────────────────────── */}
          {totalApports > 0 && (
            <StatCard
              label="Capital investi total"
              value={fmt(totalApports, currency)}
              accent={palette.primary}
              bg={palette.primaryLight}
              note={periodApports > 0 ? `dont ${fmt(periodApports, currency)} sur cette période` : undefined}
            />
          )}

        </ScrollView>
      )}
    </Screen>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
  hdr:     {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing[5], paddingVertical: spacing[4],
    backgroundColor: p.background,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.border,
  },
  content: { padding: spacing[4], gap: spacing[4], paddingBottom: spacing[10] },

  // Period chips
  periodRow:         { flexDirection: 'row', gap: spacing[2] },
  periodChip:        { flex: 1, paddingVertical: spacing[2], alignItems: 'center', borderRadius: radius.md, borderWidth: 1.5, borderColor: p.border, backgroundColor: p.surface },
  periodActive:      { backgroundColor: p.textPrimary, borderColor: p.textPrimary },
  periodLabel:       { fontSize: 13, fontWeight: '600' as const, color: p.textSecondary },
  periodLabelActive: { color: p.background },

  // Hero card
  hero:        { gap: spacing[2], alignItems: 'center', paddingVertical: spacing[5], backgroundColor: p.surface },
  heroCaption: { fontSize: 14, color: p.textSecondary, fontWeight: '500' as const, textAlign: 'center' as const },
  heroAmount:  { fontSize: 34, fontWeight: '800' as const, color: p.textPrimary, letterSpacing: -0.5, lineHeight: 42 },
  heroSub:     { fontSize: 13, color: p.textSecondary, textAlign: 'center' as const },

  // 2-col grid
  gridRow:   { flexDirection: 'row', gap: spacing[4] },
  statCard:  { flex: 1, gap: spacing[1], minHeight: 90 },
  statLabel: { fontSize: 12, color: p.textSecondary, fontWeight: '500' as const },
  statValue: { fontSize: 16, fontWeight: '700' as const, lineHeight: 22 },
  statNote:  { fontSize: 11, color: p.textSecondary },

  // Section title
  sectionTitle: { fontSize: 14, fontWeight: '700' as const, color: p.textPrimary },

  // Section separator
  sectionSep:      { flexDirection: 'row' as const, alignItems: 'center' as const, gap: spacing[3] },
  sectionSepLine:  { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: p.border },
  sectionSepLabel: { fontSize: 11, color: p.textSecondary, fontWeight: '600' as const, textTransform: 'uppercase' as const, letterSpacing: 0.8 },

  // Bar chart
  barsRow:  { flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 80 },
  barWrap:  { flex: 1, alignItems: 'center', gap: 3, justifyContent: 'flex-end' },
  bar:      { width: '100%', backgroundColor: p.primary, borderRadius: 3, minHeight: 4 },
  barLabel: { fontSize: 9, color: p.textSecondary, textAlign: 'center' as const },

  // List rows
  listRow:    { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },

  // Seller progress bar
  barTrack: { height: 4, backgroundColor: p.border, borderRadius: 2, marginLeft: 18, marginRight: 4 },
  barFill:  { height: 4, backgroundColor: p.primary, borderRadius: 2 },
  });
}
