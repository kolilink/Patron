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
  buildFounderKpis,
  type FounderKpi,
  type HealthStatus,
  type UserActivityRecord,
} from '@/src/utils/founderMetrics';

interface FounderActivityRow {
  user_id: string;
  signup_at: string;
  transaction_at: string[] | null;
}

// Founder-only "First Principles" growth panel — see founderMetrics.ts for the
// calculation logic itself. This component only owns: fetching the raw
// per-user activity rows, mapping them to UserActivityRecord[], and
// rendering the 4 resulting KPIs with health-status coloring.
//
// Refetches on every focus (useFocusEffect), not just on mount — dedicated to
// its own screen (app/(app)/founder-kpi), so "tap in and see it live" means
// re-running the query each time that screen is reached, same convention
// support-inbox's loadFounderConversations() already uses.
export function FounderDashboard() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);

  const [kpis, setKpis] = useState<FounderKpi[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(useCallback(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const { data, error: rpcError } = await supabase.rpc('get_founder_activity_raw');
        if (rpcError) throw rpcError;
        if (cancelled) return;

        const records: UserActivityRecord[] = ((data ?? []) as FounderActivityRow[]).map(row => ({
          userId: row.user_id,
          signupAt: row.signup_at,
          transactionTimestamps: row.transaction_at ?? [],
        }));

        setKpis(buildFounderKpis(records));
      } catch (err) {
        if (!cancelled) setError(translateError(err, 'Erreur de chargement'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, []));

  if (loading && !kpis) {
    return <SkeletonKpiGrid />;
  }

  if (error) {
    return (
      <View style={styles.errorBox}>
        <Text variant="caption" color="secondary">{error}</Text>
      </View>
    );
  }

  if (!kpis) return null;

  return (
    <View style={styles.grid}>
      {kpis.map(kpi => (
        <FounderKpiCard key={kpi.key} kpi={kpi} palette={palette} styles={styles} />
      ))}
    </View>
  );
}

function healthColor(palette: Palette, status: HealthStatus | null): string {
  if (status === 'green') return palette.healthGreen;
  if (status === 'yellow') return palette.healthYellow;
  if (status === 'red') return palette.healthRed;
  return palette.textDisabled;
}

function FounderKpiCard({
  kpi,
  palette,
  styles,
}: {
  kpi: FounderKpi;
  palette: Palette;
  styles: ReturnType<typeof makeStyles>;
}) {
  const color = healthColor(palette, kpi.status);
  return (
    <View style={[styles.card, { borderLeftColor: color }]}>
      <Text variant="h4" style={{ color }}>{kpi.displayValue}</Text>
      <Text variant="caption" color="secondary" style={styles.label}>{kpi.label}</Text>
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
    label: {
      marginTop: spacing[1],
    },
    errorBox: {
      padding: spacing[3],
    },
  });
}
