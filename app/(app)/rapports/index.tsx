import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, LayoutAnimation, Platform, Pressable, ScrollView, StyleSheet, UIManager, View } from 'react-native';
import { Screen } from '@/src/components/ui/Screen';
import { router, useFocusEffect } from 'expo-router';
import { Card } from '@/src/components/ui/Card';
import { SkeletonKpiGrid } from '@/src/components/ui/SkeletonPlaceholder';
import { OfflineNotice } from '@/src/components/ui/OfflineNotice';
import { Text } from '@/src/components/ui/Text';
import { DatePickerField } from '@/src/components/ui/DatePickerField';
import { YearHeatmap } from '@/src/components/ui/YearHeatmap';
import { useTheme, spacing, radius } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useRapportsStore, type PeriodReport } from '@/stores/rapports';

function fmt(n: number, cur: string) {
  return `${Math.round(n).toLocaleString('fr-FR')} ${cur}`;
}

// ── Calendar helpers ─────────────────────────────────────────────────────────
// All calendar-anchored, matching get_period_report's contract — a "year" is
// just the widest possible [period_start, period_end], no special-cased path.

function todayIso(): string {
  return new Date().toISOString().split('T')[0];
}

function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dayFromIso(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

// No year in either of these — the year selector above is already on
// screen showing which year is being browsed, so repeating "2026" on
// every sub-label read as redundant noise rather than useful context.
function fmtDateFr(iso: string): string {
  return dayFromIso(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

function weekRange(anchor: Date): { start: string; end: string } {
  const dow = (anchor.getDay() + 6) % 7; // 0=Mon
  const start = new Date(anchor); start.setDate(anchor.getDate() - dow);
  const end = new Date(start); end.setDate(start.getDate() + 6);
  return { start: isoOf(start), end: isoOf(end) };
}

function monthRange(anchor: Date): { start: string; end: string } {
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  return { start: isoOf(start), end: isoOf(end) };
}

function fmtMonthFr(iso: string): string {
  const label = dayFromIso(iso).toLocaleDateString('fr-FR', { month: 'long' });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// Guarantees a valid, non-future, non-inverted [start,end] regardless of how
// the caller computed it — a fully-future month (e.g. viewing December while
// it's still July) would otherwise send start > end to the RPC, which
// rejects that outright. Collapsing to a same-day "today" range is a rare,
// harmless degenerate case rather than a crash.
function clampToToday(r: { start: string; end: string }): { start: string; end: string } {
  const today = todayIso();
  const end = r.end > today ? today : r.end;
  const start = r.start > end ? end : r.start;
  return { start, end };
}

// No "Année"/"Jour" chip — the plain heatmap+headline (no filter selected)
// already is the year view, and a single day is read straight off the
// heatmap via its own tap-tooltip (see YearHeatmap), not a separate filter.
type FilterType = 'semaine' | 'mois' | 'personnalise';
const FILTER_CHIPS: { key: FilterType; label: string }[] = [
  { key: 'semaine',      label: 'Semaine' },
  { key: 'mois',         label: 'Mois' },
  { key: 'personnalise', label: 'Personnalisé' },
];

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
  const userId       = session?.user.id ?? '';
  const currency     = session?.activeBusiness?.currency ?? 'GNF';
  const role           = session?.activeMembership?.role;
  const isVendeur      = role === 'vendeur';
  // Title reflects scope, not what's shown: admin/manager run the whole shop
  // → "Les chiffres"; vendeur (own sales) and investisseur (their stake) → "Mes chiffres".
  const seesWholeBusiness = role === 'administrateur' || role === 'manager';

  const {
    yearReport, yearReportLoading,
    filterReport, filterReportLoading,
    periodOffline, periodOfflineSince,
    fetchYearReport, fetchFilterReport, clearFilterReport,
  } = useRapportsStore();

  const currentYear = new Date().getFullYear();
  // "The first year is the year they started" — never let the year selector
  // go back before the business existed; there's structurally no data there.
  const creationYear = session?.activeBusiness?.created_at
    ? new Date(session.activeBusiness.created_at).getFullYear()
    : currentYear;
  const [year, setYear] = useState(currentYear);
  const isCurrentYear = year === currentYear;

  const [filterType, setFilterType] = useState<FilterType | null>(null);
  const [weekAnchor, setWeekAnchor] = useState(todayIso);
  const [monthAnchor, setMonthAnchor] = useState(todayIso);
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd]     = useState('');

  // Picking a chip (or stepping/typing a new range) makes a sub-control
  // and/or the detail panel appear or change shape below the chips row.
  // Two complementary motions handle this, not one:
  //  1. A native ease-in-ease-out LayoutAnimation (fade + reflow) smooths
  //     the content that's already on screen changing shape — no hard cut.
  //  2. A hand-driven, calm scroll (below) nudges the viewport when the
  //     new/changed content would otherwise land off-screen — LayoutAnimation
  //     alone never moves the scroll position, so without this, content
  //     appearing below the fold is invisible until the user finds it
  //     themselves.
  useEffect(() => {
    if (Platform.OS === 'android') UIManager.setLayoutAnimationEnabledExperimental?.(true);
  }, []);
  const animateFilterChange = () => {
    LayoutAnimation.configureNext(
      LayoutAnimation.create(280, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity),
    );
  };

  const scrollRef = useRef<ScrollView>(null);
  const filterSectionY = useRef(0);
  const currentScrollY = useRef(0);
  const scrollAnimFrame = useRef<number | null>(null);

  // RN's ScrollView.scrollTo({animated:true}) has no duration knob — its
  // native animation is a fixed, fairly quick easing curve, closer to a
  // flick than the calm/unhurried feel this screen wants. Driven by hand
  // instead: sample eased intermediate offsets over `duration` via rAF,
  // applied with animated:false (each frame is already the eased position,
  // native animation on top would fight it). Sine ease-in-out — a smooth,
  // continuous half-cosine with no sharp acceleration anywhere in the
  // curve — is the gentlest of the common easings, the same "don't demand
  // attention" motion quality as this app's breathing CTA pulse (see
  // PaywallScreen's BREATH_HALF_CYCLE_MS).
  const easeInOutSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;
  const smoothScrollTo = useCallback((targetY: number, duration = 1500) => {
    if (scrollAnimFrame.current != null) cancelAnimationFrame(scrollAnimFrame.current);
    const startY = currentScrollY.current;
    const distance = targetY - startY;
    const startTime = Date.now();
    const step = () => {
      const elapsed = Date.now() - startTime;
      const t = Math.min(elapsed / duration, 1);
      scrollRef.current?.scrollTo({ y: startY + distance * easeInOutSine(t), animated: false });
      if (t < 1) {
        scrollAnimFrame.current = requestAnimationFrame(step);
      } else {
        scrollAnimFrame.current = null;
      }
    };
    scrollAnimFrame.current = requestAnimationFrame(step);
  }, []);

  useEffect(() => () => {
    if (scrollAnimFrame.current != null) cancelAnimationFrame(scrollAnimFrame.current);
  }, []);

  // Reset the active filter whenever the business OR the viewed year
  // changes, and re-anchor the week/month steppers inside the newly
  // viewed year (today for the current year, Dec 31 for a past one) —
  // a stale anchor from a different year would silently produce a range
  // outside the year actually on screen, which matters now that the week/
  // month labels no longer repeat the year (it's redundant with the year
  // selector above, so a mismatched anchor would be invisible in the UI).
  useEffect(() => {
    animateFilterChange();
    setFilterType(null);
    const anchor = year === currentYear ? todayIso() : `${year}-12-31`;
    setWeekAnchor(anchor);
    setMonthAnchor(anchor);
  }, [businessId, year, currentYear]);

  const selectFilter = (key: FilterType) => {
    animateFilterChange();
    setFilterType(prev => (prev === key ? null : key));
  };

  const filterRange = useMemo(() => {
    switch (filterType) {
      case null:
        return null;
      case 'semaine':
        return clampToToday(weekRange(dayFromIso(weekAnchor)));
      case 'mois':
        return clampToToday(monthRange(dayFromIso(monthAnchor)));
      case 'personnalise':
        return customStart && customEnd ? clampToToday({ start: customStart, end: customEnd }) : null;
    }
  }, [filterType, weekAnchor, monthAnchor, customStart, customEnd]);

  // Fires when a chip is picked, switched, or its range resolves (e.g.
  // Personnalisé only gets a filterRange once both dates are typed) — never
  // on deselect (filterType null), since collapsing content needs no scroll.
  useEffect(() => {
    if (!filterType) return;
    const t = setTimeout(() => {
      const target = Math.max(filterSectionY.current - spacing[4], 0);
      // Skip the nudge entirely when we're already this close — otherwise
      // switching Semaine → Mois while both sit in roughly the same place
      // re-fires a full scroll each time, which reads as the screen
      // fighting the tap instead of just swapping the numbers in place.
      if (Math.abs(target - currentScrollY.current) > 40) {
        smoothScrollTo(target);
      }
    }, 60);
    return () => clearTimeout(t);
  }, [filterType, filterRange?.start, filterRange?.end, smoothScrollTo]);

  useFocusEffect(
    useCallback(() => {
      if (!businessId || !role) return;
      fetchYearReport(businessId, year, role, userId);
    }, [businessId, role, userId, year]),
  );

  useEffect(() => {
    if (!businessId || !role) return;
    if (filterRange) {
      fetchFilterReport(businessId, filterRange.start, filterRange.end, role, userId);
    } else {
      clearFilterReport();
    }
  }, [businessId, role, userId, filterRange?.start, filterRange?.end, fetchFilterReport, clearFilterReport]);

  // ── Headline (year-level) values ──────────────────────────────────────────
  const cashOnHand        = yearReport?.cash_on_hand        ?? 0;
  const yearProfit        = yearReport?.net_profit          ?? 0;
  const yearSalesCount    = yearReport?.sales_count          ?? 0;
  const yearUnitsSold     = yearReport?.units_sold           ?? 0;

  const myYearSalesCount  = yearReport?.my_sales_count       ?? 0;
  const myYearUnitsSold   = yearReport?.my_units_sold        ?? 0;

  const heatmapData = isVendeur ? (yearReport?.my_daily ?? []) : (yearReport?.daily ?? []);

  const periodLabel = filterRange
    ? filterRange.start === filterRange.end
      ? fmtDateFr(filterRange.start)
      : `du ${fmtDateFr(filterRange.start)} au ${fmtDateFr(filterRange.end)}`
    : '';

  const legend = (
    <View style={styles.legendRow}>
      <Text variant="caption" color="secondary">−</Text>
      <View style={[styles.legendSwatch, { backgroundColor: palette.border }]} />
      <View style={[styles.legendSwatch, { backgroundColor: `${palette.success}4D` }]} />
      <View style={[styles.legendSwatch, { backgroundColor: `${palette.success}FF` }]} />
      <Text variant="caption" color="secondary">+</Text>
    </View>
  );

  const filterChipsRow = (
    <View style={styles.periodRow}>
      {FILTER_CHIPS.map(c => (
        <Pressable key={c.key} onPress={() => selectFilter(c.key)}
          style={[styles.periodChip, filterType === c.key && styles.periodActive]}>
          <Text style={[styles.periodLabel, filterType === c.key && styles.periodLabelActive]}>{c.label}</Text>
        </Pressable>
      ))}
    </View>
  );

  const filterSubControl = (() => {
    switch (filterType) {
      case 'semaine': {
        const r = weekRange(dayFromIso(weekAnchor));
        // Can't step into a week that hasn't happened yet — there's no
        // sales data for the future. Without this bound, stepping forward
        // past today's week produced a range clampToToday then silently
        // collapsed into a confusing single "today" day, while the chip
        // above still showed the full (fictional) future week.
        const currentWeekStart = weekRange(new Date()).start;
        const atLastWeek = r.start >= currentWeekStart;
        return (
          <View style={styles.stepperRow}>
            <Pressable onPress={() => setWeekAnchor(iso => isoOf(new Date(dayFromIso(iso).setDate(dayFromIso(iso).getDate() - 7))))}>
              <Text variant="h4" color="secondary">‹</Text>
            </Pressable>
            <Text variant="body">{fmtDateFr(r.start)} au {fmtDateFr(r.end)}</Text>
            {/* Hidden entirely (not just greyed) once the next step would
                land in the future — there's nothing there to go see. */}
            <Pressable
              onPress={() => setWeekAnchor(iso => isoOf(new Date(dayFromIso(iso).setDate(dayFromIso(iso).getDate() + 7))))}
              disabled={atLastWeek}
              style={atLastWeek ? { opacity: 0 } : undefined}
            >
              <Text variant="h4" color="secondary">›</Text>
            </Pressable>
          </View>
        );
      }
      case 'mois': {
        const r = monthRange(dayFromIso(monthAnchor));
        const monthDate = dayFromIso(monthAnchor);
        // Bounded to the year currently on screen — the month label no
        // longer shows a year (see fmtMonthFr), so silently drifting into
        // a different year here would be invisible in the UI.
        const atFirstMonth = monthDate.getMonth() === 0;
        const atLastMonth = monthDate.getMonth() === (isCurrentYear ? new Date().getMonth() : 11);
        return (
          <View style={styles.stepperRow}>
            <Pressable
              onPress={() => !atFirstMonth && setMonthAnchor(iso => { const d = dayFromIso(iso); return isoOf(new Date(d.getFullYear(), d.getMonth() - 1, 1)); })}
              disabled={atFirstMonth}
            >
              <Text variant="h4" color={atFirstMonth ? 'disabled' : 'secondary'}>‹</Text>
            </Pressable>
            <Text variant="body">{fmtMonthFr(r.start)}</Text>
            {/* Hidden entirely (not just greyed) once the next step would
                land in the future — there's nothing there to go see. */}
            <Pressable
              onPress={() => setMonthAnchor(iso => { const d = dayFromIso(iso); return isoOf(new Date(d.getFullYear(), d.getMonth() + 1, 1)); })}
              disabled={atLastMonth}
              style={atLastMonth ? { opacity: 0 } : undefined}
            >
              <Text variant="h4" color="secondary">›</Text>
            </Pressable>
          </View>
        );
      }
      case 'personnalise':
        return (
          <View style={styles.customRow}>
            <View style={{ flex: 1 }}>
              <DatePickerField label="Début" value={customStart} onChange={v => { animateFilterChange(); setCustomStart(v); }} maxToday minDate={`${year}-01-01`} />
            </View>
            <View style={{ flex: 1 }}>
              <DatePickerField label="Fin" value={customEnd} onChange={v => { animateFilterChange(); setCustomEnd(v); }} maxToday minDate={customStart || `${year}-01-01`} />
            </View>
          </View>
        );
      default:
        return null;
    }
  })();

  // Role-gated metric rows, built from a given PeriodReport-shaped source —
  // shared between the always-visible year headline and the period detail
  // panel below, since both render the same fields off different sources.
  function renderVolumeRow(source: PeriodReport | null, loading: boolean) {
    const salesCount = isVendeur ? (source?.my_sales_count ?? 0) : (source?.sales_count ?? 0);
    const unitsSold   = isVendeur ? (source?.my_units_sold  ?? 0) : (source?.units_sold  ?? 0);
    return (
      <View style={styles.gridRow}>
        <StatCard
          label="Ventes" loading={loading}
          value={`${salesCount}`}
          accent={palette.primary} bg={palette.primaryLight}
        />
        <StatCard
          label="Produits vendus" loading={loading}
          value={`${Math.round(unitsSold).toLocaleString('fr-FR')}`}
          accent={palette.primary} bg={palette.primaryLight}
        />
      </View>
    );
  }

  if (yearReportLoading && !yearReport) {
    return (
      <Screen>
        <View style={styles.hdr}>
          <Pressable onPress={() => router.back()}>
            <Text variant="body" color="secondary">‹ Retour</Text>
          </Pressable>
          <Text variant="h4">{seesWholeBusiness ? 'Les chiffres' : 'Mes chiffres'}</Text>
          <View style={{ width: 60 }} />
        </View>
        <SkeletonKpiGrid />
      </Screen>
    );
  }

  if (periodOffline && !yearReport) {
    return (
      <Screen>
        <View style={styles.hdr}>
          <Pressable onPress={() => router.back()}>
            <Text variant="body" color="secondary">‹ Retour</Text>
          </Pressable>
          <Text variant="h4">{seesWholeBusiness ? 'Les chiffres' : 'Mes chiffres'}</Text>
          <View style={{ width: 60 }} />
        </View>
        <OfflineNotice
          offlineSince={periodOfflineSince}
          onRetry={() => { if (role) fetchYearReport(businessId, year, role, userId); }}
        />
        <View style={styles.content}>
          <Text variant="body" color="secondary" style={{ textAlign: 'center', marginTop: spacing[8] }}>
            Données non disponibles hors ligne. Ouvrez l'application en ligne une première fois pour activer le mode hors ligne.
          </Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={styles.hdr}>
        <Pressable onPress={() => router.back()}>
          <Text variant="body" color="secondary">‹ Retour</Text>
        </Pressable>
        <Text variant="h4">{seesWholeBusiness ? 'Les chiffres' : 'Mes chiffres'}</Text>
        <View style={{ width: 60 }} />
      </View>

      {periodOffline && (
        <OfflineNotice
          offlineSince={periodOfflineSince}
          onRetry={() => {
            if (!role) return;
            if (filterRange) fetchFilterReport(businessId, filterRange.start, filterRange.end, role, userId);
            else fetchYearReport(businessId, year, role, userId);
          }}
        />
      )}

      <ScrollView
        ref={scrollRef}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        onScroll={e => { currentScrollY.current = e.nativeEvent.contentOffset.y; }}
        scrollEventThrottle={16}
      >

        {/* ── Year selector — floored at the year the business started ────── */}
        <View style={styles.yearRow}>
          <Pressable onPress={() => year > creationYear && setYear(y => y - 1)} hitSlop={12} disabled={year <= creationYear}>
            <Text variant="h4" color={year <= creationYear ? 'disabled' : 'secondary'}>‹</Text>
          </Pressable>
          <Text variant="h3">{year}</Text>
          {/* Hidden entirely (not just greyed) once the next year would be
              in the future — there's nothing there to go see. */}
          <Pressable
            onPress={() => setYear(y => y + 1)}
            hitSlop={12}
            disabled={year >= currentYear}
            style={year >= currentYear ? { opacity: 0 } : undefined}
          >
            <Text variant="h4" color="secondary">›</Text>
          </Pressable>
        </View>

        {/* ── Headline: cash + profit (admin/manager/investisseur only) ──── */}
        {!isVendeur && (
          <View style={styles.gridRow}>
            <StatCard
              label="Argent disponible" loading={yearReportLoading}
              value={fmt(cashOnHand, currency)}
              accent={cashOnHand >= 0 ? palette.primary : palette.warning}
              bg={cashOnHand >= 0 ? palette.primaryLight : palette.warningLight}
            />
            <StatCard
              label={`Bénéfice cumulé ${year}`} loading={yearReportLoading}
              value={fmt(yearProfit, currency)}
              accent={yearProfit >= 0 ? palette.success : palette.warning}
              bg={yearProfit >= 0 ? palette.successLight : palette.warningLight}
            />
          </View>
        )}

        {/* ── Sales volume — always visible, motivational, never hidden ──── */}
        {renderVolumeRow(yearReport, yearReportLoading)}

        {/* ── Year heatmap ─────────────────────────────────────────────────── */}
        <Card style={{ gap: spacing[3] }}>
          <Text style={styles.sectionTitle}>Activité</Text>
          <YearHeatmap
            year={year}
            data={heatmapData}
            highlightRange={filterRange}
            defaultMonth={isCurrentYear ? new Date().getMonth() + 1 : undefined}
          />
          {legend}
        </Card>

        {/* ── Period filter ─────────────────────────────────────────────────── */}
        <View
          style={{ gap: spacing[4] }}
          onLayout={e => { filterSectionY.current = e.nativeEvent.layout.y; }}
        >
          {filterChipsRow}
          {filterSubControl}

          {/* ── Period detail panel — only while a filter chip is active. ──────
               Tapping the active chip again clears it and hides this panel. */}
          {filterRange && (
            <>
              <SectionSep label={periodLabel} />
              {!isVendeur && (
                <StatCard
                  label="Bénéfice de la période" loading={filterReportLoading}
                  value={fmt(filterReport?.net_profit ?? 0, currency)}
                  accent={(filterReport?.net_profit ?? 0) >= 0 ? palette.success : palette.warning}
                  bg={(filterReport?.net_profit ?? 0) >= 0 ? palette.successLight : palette.warningLight}
                />
              )}
              {renderVolumeRow(filterReport, filterReportLoading)}
            </>
          )}
        </View>


      </ScrollView>
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

  // Year selector
  yearRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing[5] },

  // Period / filter chips
  periodRow:         { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2], justifyContent: 'center' },
  periodChip:        { paddingVertical: spacing[2], paddingHorizontal: spacing[3], alignItems: 'center', borderRadius: radius.md, borderWidth: 1.5, borderColor: p.border, backgroundColor: p.surface },
  periodActive:      { backgroundColor: p.textPrimary, borderColor: p.textPrimary },
  periodLabel:       { fontSize: 13, fontWeight: '600' as const, color: p.textSecondary },
  periodLabelActive: { color: p.background },
  stepperRow:        { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing[2] },
  customRow:         { flexDirection: 'row', gap: spacing[3] },

  // Hero card (investisseur ROI)
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

  // Heatmap legend
  legendRow:    { flexDirection: 'row', alignItems: 'center', gap: spacing[1], alignSelf: 'flex-end' },
  legendSwatch: { width: 10, height: 10, borderRadius: 2.5 },
  });
}
