import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Text } from '@/src/components/ui/Text';
import { SkeletonKpiGrid } from '@/src/components/ui/SkeletonPlaceholder';
import { useTheme, spacing, radius } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { supabase } from '@/lib/supabase';
import { translateError } from '@/lib/errors';
import {
  getHealthStatus,
  identifyConstraint,
  ACTIVATION_BENCHMARK,
  WEEK1_RETENTION_BENCHMARK,
  WEEK4_RETENTION_BENCHMARK,
  NORTH_STAR_RATE_BENCHMARK,
  type HealthStatus,
} from '@/src/utils/growthConstraint';

interface GrowthStatsRow {
  activation_rate_pct: number | null;
  week1_retention_pct: number | null;
  week4_retention_pct: number | null;
  weekly_transacting_shops: number;
  total_real_businesses: number;
}

// Founder-only growth panel — Activation / Retention / North Star, backed by
// get_founder_growth_stats() (db/migration_v174.sql/v175.sql), which reads
// from the growth_metrics view (business-level cohort: signup_at,
// activated_72h, week1_retained, week4_retained). See CLAUDE.md's "Founder
// Dashboard" section for the full reasoning behind each metric's
// definition — in particular why the retention windows are week-wide, not
// single-day, and why demo/anonymous businesses are excluded from the
// cohort.
//
// Card colors and the one-sentence constraint callout both come from
// src/utils/growthConstraint.ts (benchmarks + pure logic, independently
// testable) — this component only owns fetching + rendering.
//
// Replaces the earlier D7-retention / daily-active / TTFR /
// avg-tx-per-active-user panel (founderMetrics.ts, now deleted) — that
// framework's get_founder_activity_raw() RPC is still deployed and valid,
// just no longer called from here.
//
// Refetches on every focus (useFocusEffect), not just on mount — dedicated
// to its own screen (app/(app)/founder-kpi), so "tap in and see it live"
// means re-running the query each time that screen is reached, same
// convention support-inbox's loadFounderConversations() already uses.
export function FounderDashboard() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);

  const [stats, setStats] = useState<GrowthStatsRow | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(useCallback(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const { data, error: rpcError } = await supabase.rpc('get_founder_growth_stats');
        if (rpcError) throw rpcError;
        if (cancelled) return;

        const rows = (data ?? []) as GrowthStatsRow[];
        setStats(rows[0] ?? null);
      } catch (err) {
        if (!cancelled) setError(translateError(err, 'Erreur de chargement'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, []));

  if (loading && !stats) {
    return <SkeletonKpiGrid />;
  }

  if (error) {
    return (
      <View style={styles.errorBox}>
        <Text variant="caption" color="secondary">{error}</Text>
      </View>
    );
  }

  if (!stats) return null;

  // North Star is benchmarked as a *rate* (weekly transacting / every real
  // business ever created), not the raw count — a fixed absolute-count bar
  // would need re-tuning by hand every time the platform grows. The card
  // still displays the raw count; only its health color uses the rate.
  const northStarRatePct = stats.total_real_businesses > 0
    ? (stats.weekly_transacting_shops / stats.total_real_businesses) * 100
    : null;

  const constraintSentence = identifyConstraint({
    activationRatePct: stats.activation_rate_pct,
    week1RetentionPct: stats.week1_retention_pct,
    week4RetentionPct: stats.week4_retention_pct,
    weeklyTransactingShops: stats.weekly_transacting_shops,
    totalRealBusinesses: stats.total_real_businesses,
  });

  return (
    <View>
      <View style={styles.grid}>
        <GrowthStatCard
          label="Taux d'activation (30j)"
          value={formatPct(stats.activation_rate_pct)}
          status={getHealthStatus(stats.activation_rate_pct, ACTIVATION_BENCHMARK)}
          palette={palette}
          styles={styles}
        />
        <GrowthStatCard
          label="Rétention Semaine 1"
          value={formatPct(stats.week1_retention_pct)}
          status={getHealthStatus(stats.week1_retention_pct, WEEK1_RETENTION_BENCHMARK)}
          palette={palette}
          styles={styles}
        />
        <GrowthStatCard
          label="Rétention Semaine 4"
          value={formatPct(stats.week4_retention_pct)}
          status={getHealthStatus(stats.week4_retention_pct, WEEK4_RETENTION_BENCHMARK)}
          palette={palette}
          styles={styles}
        />
        <GrowthStatCard
          label="Commerces actifs / semaine"
          caption="North Star"
          value={String(stats.weekly_transacting_shops)}
          status={getHealthStatus(northStarRatePct, NORTH_STAR_RATE_BENCHMARK)}
          palette={palette}
          styles={styles}
        />
      </View>

      <Text variant="bodySmall" color="secondary" style={styles.constraint}>
        {constraintSentence}
      </Text>
    </View>
  );
}

function formatPct(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)}%`;
}

function healthColor(palette: Palette, status: HealthStatus | null): string {
  if (status === 'green') return palette.healthGreen;
  if (status === 'yellow') return palette.healthYellow;
  if (status === 'red') return palette.healthRed;
  return palette.textDisabled;
}

function GrowthStatCard({
  label,
  value,
  caption,
  status,
  palette,
  styles,
}: {
  label: string;
  value: string;
  caption?: string;
  status: HealthStatus | null;
  palette: Palette;
  styles: ReturnType<typeof makeStyles>;
}) {
  const color = healthColor(palette, status);
  return (
    <View style={[styles.card, { borderLeftColor: color }]}>
      {caption && <Text variant="caption" color="secondary" style={styles.caption}>{caption}</Text>}
      <Text variant="h4" style={{ color }}>{value}</Text>
      <Text variant="caption" color="secondary" style={styles.label}>{label}</Text>
    </View>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    grid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing[2],
    },
    card: {
      flexBasis: '48%',
      flexGrow: 1,
      backgroundColor: p.background,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: p.border,
      borderLeftWidth: 3,
      paddingHorizontal: spacing[3],
      paddingVertical: spacing[3],
    },
    caption: {
      marginBottom: spacing[1],
      fontWeight: '600',
    },
    label: {
      marginTop: spacing[1],
    },
    constraint: {
      marginTop: spacing[4],
      lineHeight: 20,
    },
    errorBox: {
      padding: spacing[3],
    },
  });
}
