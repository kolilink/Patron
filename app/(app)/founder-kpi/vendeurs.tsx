import { useCallback, useEffect, useMemo, useState } from 'react';
import { appAlert } from '@/src/utils/appAlert';
import { FlatList, Linking, Pressable, StyleSheet, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Screen } from '@/src/components/ui/Screen';
import { Text } from '@/src/components/ui/Text';
import { SkeletonKpiGrid } from '@/src/components/ui/SkeletonPlaceholder';
import { DataState } from '@/src/components/ui/DataState';
import { useTheme, spacing, radius } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { supabase } from '@/lib/supabase';
import { withTimeout } from '@/lib/sync';
import { translateError } from '@/lib/errors';
import { useAuthStore } from '@/stores/auth';
import { isFounderPhone } from '@/src/utils/founder';
import { haptics } from '@/lib/haptics';
import { showFailureAlert } from '@/src/components/ui/FailureView';
import { buildFailure, failureReason } from '@/src/utils/failure';
import { FAILURE_COPY } from '@/src/utils/failureCopy';
import {
  DIRECTORY_FILTERS,
  daysAgoLabel,
  filterRows,
  parseFilter,
  whatsappUrl,
  type DirectoryFilter,
  type DirectoryRow,
} from '@/src/utils/founderDirectory';

// Founder-only: every real vendor with their phone number, so the founder
// can text them. Reached from the "Voir les commerces perdus" link on the KPI
// screen and from the "New user" push (route /(app)/founder-kpi/vendeurs).
// Test/demo businesses are already excluded server-side.
export default function FounderVendorDirectoryScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const session = useAuthStore(s => s.session);
  const isFounder = isFounderPhone(session?.user.phone);
  const params = useLocalSearchParams<{ filtre?: string }>();

  const [filter, setFilter] = useState<DirectoryFilter>(parseFilter(params.filtre));
  const [rows, setRows] = useState<DirectoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!isFounder) {
      if (router.canGoBack()) router.back();
      else router.replace('/(app)/(tabs)/');
    }
  }, [isFounder]);

  useFocusEffect(useCallback(() => {
    if (!isFounder) return;
    let cancelled = false;
    (async () => {
      try {
        const { data, error: e } = await withTimeout(supabase.rpc('get_founder_vendor_directory'));
        if (e) throw e;
        if (!cancelled) { setRows((data ?? []) as DirectoryRow[]); setError(null); }
      } catch (err) {
        // failure: speaks — the screen shows the sentence with a Réessayer
        if (!cancelled) setError(translateError(err, "Le chargement n'a pas abouti."));
      }
    })();
    return () => { cancelled = true; };
  }, [isFounder, reloadToken]));

  if (!isFounder) return null;

  const visible = rows ? filterRows(rows, filter) : [];

  const markTest = (row: DirectoryRow) => {
    appAlert(
      'Marquer comme test ?',
      `« ${row.business_name ?? 'Ce commerce'} » sera exclu de tous les chiffres.`,
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Marquer test',
          onPress: async () => {
            try {
              const { error: e } = await withTimeout(supabase.rpc('set_business_is_test', { p_business_id: row.business_id, p_is_test: true }));
              if (e) throw e;
              setReloadToken(t => t + 1);
            } catch (err) {
              // failure: speaks — failure alert with Retour
              haptics.error();
              showFailureAlert(buildFailure({ what: FAILURE_COPY.testFlagNotChanged.what, why: failureReason(err), action: { label: 'Retour', onPress: () => {} } }));
            }
          },
        },
      ],
    );
  };

  const open = (row: DirectoryRow) => {
    const url = whatsappUrl(row);
    if (url) Linking.openURL(url).catch(() => {});
  };

  return (
    <Screen>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()}>
          <Text variant="body" color="secondary">‹ Retour</Text>
        </Pressable>
        <Text variant="h4">Vendeurs</Text>
        <View style={{ width: 60 }} />
      </View>

      <View style={styles.chips}>
        {DIRECTORY_FILTERS.map(f => {
          const active = f.key === filter;
          return (
            <Pressable
              key={f.key}
              onPress={() => setFilter(f.key)}
              style={[styles.chip, active && { backgroundColor: palette.textPrimary, borderColor: palette.textPrimary }]}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
            >
              <Text variant="bodySmall" style={active ? { color: palette.textInverse } : undefined}>{f.label}</Text>
            </Pressable>
          );
        })}
      </View>

      <DataState
        status={rows ? 'ready' : error ? 'error' : 'loading'}
        isEmpty={!rows}
        skeleton={<View style={styles.pad}><SkeletonKpiGrid /></View>}
        empty={(
        <View style={styles.pad}>
          <Text variant="bodySmall" color="secondary">{error}</Text>
          <Pressable onPress={() => setReloadToken(t => t + 1)} style={{ paddingVertical: spacing[2] }}>
            <Text variant="label" color="primary">Réessayer</Text>
          </Pressable>
        </View>
      )}
      >
        <FlatList
          data={visible}
          keyExtractor={r => r.business_id}
          contentContainerStyle={styles.pad}
          ListHeaderComponent={
            <Text variant="caption" color="secondary" style={{ marginBottom: spacing[2] }}>
              Touchez une ligne pour écrire sur WhatsApp (message prêt). Appui long : marquer comme test.
            </Text>
          }
          ListEmptyComponent={<Text variant="caption" color="secondary">Personne dans cette liste.</Text>}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => open(item)}
              onLongPress={() => markTest(item)}
              style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
            >
              <View style={{ flex: 1 }}>
                <Text variant="bodySmall" numberOfLines={1}>{item.owner_name || 'Sans nom'} · {item.business_name ?? '—'}</Text>
                <Text variant="caption" color="secondary" numberOfLines={1}>
                  {item.lost
                    ? `perdu · dernière action ${daysAgoLabel(item.last_action_at)}`
                    : `créé ${daysAgoLabel(item.created_at)} · ${item.first_value_at ? '1ʳᵉ vente ✓' : 'pas encore de vente'}`}
                </Text>
              </View>
              <Text variant="caption" color="secondary">{item.owner_phone ?? ''}</Text>
            </Pressable>
          )}
        />
      </DataState>
    </Screen>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    header: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      padding: spacing[5], borderBottomWidth: 1, borderBottomColor: p.border,
    },
    chips: { flexDirection: 'row', gap: spacing[2], paddingHorizontal: spacing[5], paddingVertical: spacing[3] },
    chip: { borderWidth: 1, borderColor: p.border, borderRadius: radius.full, paddingHorizontal: spacing[3], paddingVertical: spacing[2] },
    pad: { paddingHorizontal: spacing[5], paddingBottom: spacing[10] },
    row: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[3],
      paddingVertical: spacing[3], borderTopWidth: 1, borderTopColor: p.border,
    },
  });
}
