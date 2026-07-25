import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Pressable, ScrollView, StyleSheet, View } from 'react-native';
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

  // Reset the active filter whenever the business OR the viewed year
  // changes, and re-anchor the week/month steppers inside the newly
  // viewed year (today for the current year, Dec 31 for a past one) —
  // a stale anchor from a different year would silently produce a range
  // outside the year actually on screen, which matters now that the week/
  // month labels no longer repeat the year (it's redundant with the year
  // selector above, so a mismatched anchor would be invisible in the UI).
  useEffect(() => {
    setFilterType(null);
    const anchor = year === currentYear ? todayIso() : `${year}-12-31`;
    setWeekAnchor(anchor);
    setMonthAnchor(anchor);
  }, [businessId, year, currentYear]);

  const selectFilter = (key: FilterType) => setFilterType(prev => (prev === key ? null : key));

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
      <Text variant="caption" color="secondary">Moins</Text>
      <View style={[styles.legendSwatch, { backgroundColor: palette.border }]} />
      <View style={[styles.legendSwatch, { backgroundColor: `${palette.success}4D` }]} />
      <View style={[styles.legendSwatch, { backgroundColor: `${palette.success}FF` }]} />
      <Text variant="caption" color="secondary">Plus</Text>
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
        return (
          <View style={styles.stepperRow}>
            <Pressable onPress={() => setWeekAnchor(iso => isoOf(new Date(dayFromIso(iso).setDate(dayFromIso(iso).getDate() - 7))))}>
              <Text variant="h4" color="secondary">‹</Text>
            </Pressable>
            <Text variant="body">Semaine du {fmtDateFr(r.start)} au {fmtDateFr(r.end)}</Text>
            <Pressable onPress={() => setWeekAnchor(iso => isoOf(new Date(dayFromIso(iso).setDate(dayFromIso(iso).getDate() + 7))))}>
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
            <Pressable
              onPress={() => !atLastMonth && setMonthAnchor(iso => { const d = dayFromIso(iso); return isoOf(new Date(d.getFullYear(), d.getMonth() + 1, 1)); })}
              disabled={atLastMonth}
            >
              <Text variant="h4" color={atLastMonth ? 'disabled' : 'secondary'}>›</Text>
            </Pressable>
          </View>
        );
      }
      case 'personnalise':
        return (
          <View style={styles.customRow}>
            <View style={{ flex: 1 }}>
              <DatePickerField label="Début" value={customStart} onChange={setCustomStart} maxToday minDate={`${year}-01-01`} />
            </View>
            <View style={{ flex: 1 }}>
              <DatePickerField label="Fin" value={customEnd} onChange={setCustomEnd} maxToday minDate={customStart || `${year}-01-01`} />
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
        <OfflineNotice offlineSince={periodOfflineSince} />
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

      {periodOffline && <OfflineNotice offlineSince={periodOfflineSince} />}

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

        {/* ── Year selector — floored at the year the business started ────── */}
        <View style={styles.yearRow}>
          <Pressable onPress={() => year > creationYear && setYear(y => y - 1)} hitSlop={12} disabled={year <= creationYear}>
            <Text variant="h4" color={year <= creationYear ? 'disabled' : 'secondary'}>‹</Text>
          </Pressable>
          <Text variant="h3">{year}</Text>
          <Pressable onPress={() => year < currentYear && setYear(y => y + 1)} hitSlop={12} disabled={year >= currentYear}>
            <Text variant="h4" color={year >= currentYear ? 'disabled' : 'secondary'}>›</Text>
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
        {filterChipsRow}
        {filterSubControl}

        {/* ── Period detail panel — only while a filter chip is active. ────────
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
