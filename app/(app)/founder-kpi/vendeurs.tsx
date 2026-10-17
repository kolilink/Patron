import { useCallback, useEffect, useMemo, useState } from 'react';
import { appAlert } from '@/src/utils/appAlert';
import { FlatList, Linking, Pressable, StyleSheet, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Screen } from '@/src/components/ui/Screen';
import { Text } from '@/src/components/ui/Text';
import { SkeletonKpiGrid } from '@/src/components/ui/SkeletonPlaceholder';
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
import {
  CARE_STEP_LABEL,
  careMessage,
  contactRows,
  dueStep,
  shopNumber,
  todayCount,
  type CareContact,
  type CareStateRow,
  type CareStep,
} from '@/src/utils/founderCare';
import { contactsMap, loadCareData, markCareContact, updateMorningReminder } from '@/src/utils/founderCareData';

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

  // The care-plan queue is the landing view; an explicit ?filtre= still wins.
  const [filter, setFilter] = useState<DirectoryFilter>(params.filtre ? parseFilter(params.filtre) : 'contact');
  const [rows, setRows] = useState<DirectoryRow[] | null>(null);
  const [care, setCare] = useState<CareStateRow[]>([]);
  const [contacts, setContacts] = useState<Record<string, CareContact[]>>({});
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
        const data = await loadCareData();
        if (!cancelled) {
          setRows(data.rows);
          setCare(data.care);
          setContacts(contactsMap(data.care));
          setError(null);
        }
      } catch (err) {
        // failure: speaks — the screen shows the sentence with a Réessayer
        if (!cancelled) setError(translateError(err, "Le chargement n'a pas abouti."));
      }
    })();
    return () => { cancelled = true; };
  }, [isFounder, reloadToken]));

  const dueCount = rows ? todayCount(rows, contacts) : 0;

  // Keep the 08:00 reminder in step with what is actually due.
  useEffect(() => {
    if (isFounder && rows) void updateMorningReminder(dueCount);
  }, [isFounder, rows, dueCount]);

  if (!isFounder) return null;

  const items: { row: DirectoryRow; step: CareStep | null }[] = !rows
    ? []
    : filter === 'contact'
      ? contactRows(rows, contacts)
      : filterRows(rows, filter).map(row => ({ row, step: null }));

  const markContacted = async (row: DirectoryRow, step: CareStep) => {
    const entry: CareContact = { step, contacted_at: new Date().toISOString() };
    const previous = contacts[row.business_id] ?? [];
    setContacts(c => ({ ...c, [row.business_id]: [...previous.filter(x => x.step !== step), entry] }));
    try {
      await markCareContact(row.business_id, step);
    } catch (err) {
      // failure: speaks — rolled back, failure alert with Retour
      setContacts(c => ({ ...c, [row.business_id]: previous }));
      haptics.error();
      showFailureAlert(buildFailure({ what: FAILURE_COPY.outreachNotLogged.what, why: failureReason(err), action: { label: 'Retour', onPress: () => {} } }));
    }
  };

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
    const step = rows ? dueStep(row, contacts[row.business_id] ?? []) : null;
    let message: string | undefined;
    if (rows && step) {
      const state = care.find(c => c.business_id === row.business_id);
      message = careMessage(step, row, {
        number: shopNumber(rows, row.business_id),
        total: rows.length,
        sales7d: state?.sales_7d ?? 0,
        credits7d: state?.credits_7d ?? 0,
      });
    }
    const url = whatsappUrl(row, Date.now(), message);
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
              <Text variant="bodySmall" style={active ? { color: palette.textInverse } : undefined}>
                {f.key === 'contact' ? `${f.label} (${dueCount})` : f.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {error && !rows ? (
        <View style={styles.pad}>
          <Text variant="bodySmall" color="secondary">{error}</Text>
          <Pressable onPress={() => setReloadToken(t => t + 1)} style={{ paddingVertical: spacing[2] }}>
            <Text variant="label" color="primary">Réessayer</Text>
          </Pressable>
        </View>
      ) : !rows ? (
        <View style={styles.pad}><SkeletonKpiGrid /></View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={i => i.row.business_id}
          contentContainerStyle={styles.pad}
          ListHeaderComponent={
            <View style={{ marginBottom: spacing[2] }}>
              {filter === 'contact' ? (
                <Text variant="label" style={{ marginBottom: spacing[1] }}>
                  {dueCount === 1 ? '1 personne à contacter aujourd\'hui' : `${dueCount} personnes à contacter aujourd'hui`}
                </Text>
              ) : null}
              <Text variant="caption" color="secondary">
                Touchez une ligne pour écrire sur WhatsApp (message prêt). Appui long : marquer comme test.
              </Text>
            </View>
          }
          ListEmptyComponent={<Text variant="caption" color="secondary">Personne dans cette liste.</Text>}
          renderItem={({ item: { row: item, step } }) => (
            <View style={styles.row}>
              <Pressable
                onPress={() => open(item)}
                onLongPress={() => markTest(item)}
                style={({ pressed }) => [styles.rowMain, pressed && { opacity: 0.6 }]}
              >
                <View style={{ flex: 1 }}>
                  <Text variant="bodySmall" numberOfLines={1}>{item.owner_name || 'Sans nom'} · {item.business_name ?? '—'}</Text>
                  <Text variant="caption" color="secondary" numberOfLines={1}>
                    {item.lost
                      ? `perdu · dernière action ${daysAgoLabel(item.last_action_at)}`
                      : `créé ${daysAgoLabel(item.created_at)} · ${item.first_value_at ? '1ʳᵉ vente ✓' : 'pas encore de vente'}`}
                  </Text>
                </View>
                {step ? null : <Text variant="caption" color="secondary">{item.owner_phone ?? ''}</Text>}
              </Pressable>
              {step ? (
                <View style={styles.careActions}>
                  <Text variant="caption" color="secondary">{CARE_STEP_LABEL[step]}</Text>
                  <Pressable
                    onPress={() => void markContacted(item, step)}
                    hitSlop={8}
                    style={({ pressed }) => [styles.contacted, pressed && { opacity: 0.6 }]}
                    accessibilityRole="button"
                    accessibilityLabel={`Contactée, ${CARE_STEP_LABEL[step]}`}
                  >
                    <Text variant="label" color="primary">Contactée ✓</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          )}
        />
      )}
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
    rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing[3], minHeight: 48 },
    careActions: { alignItems: 'flex-end', gap: spacing[1] },
    contacted: {
      minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center',
      borderWidth: 1, borderColor: p.border, borderRadius: radius.full, paddingHorizontal: spacing[3],
    },
  });
}
