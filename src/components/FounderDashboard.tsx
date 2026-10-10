import { useCallback, useMemo, useState } from 'react';
import { haptics } from '@/lib/haptics';
import { Pressable, StyleSheet, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Text } from '@/src/components/ui/Text';
import { Button } from '@/src/components/ui/Button';
import { Input } from '@/src/components/ui/Input';
import { FormSheet } from '@/src/components/ui/FormSheet';
import { SkeletonKpiGrid } from '@/src/components/ui/SkeletonPlaceholder';
import { DataState } from '@/src/components/ui/DataState';
import { useTheme, spacing, radius } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { supabase } from '@/lib/supabase';
import { withTimeout } from '@/lib/sync';
import { translateError } from '@/lib/errors';
import {
  FOUNDER_CARDS,
  activationCard,
  commercesActifsCard,
  formatDuration,
  formatPct,
  funnelSteps,
  parrainageCard,
  prospectionCard,
  retentionCard,
  type FounderCardKey,
  type FounderKpis,
  type HealthStatus,
  type Trend,
} from '@/src/utils/founderKpis';
import { OUTREACH_CHANNELS, outreachParams, type OutreachChannel } from '@/src/utils/founderOutreach';
import { showFailureAlert } from '@/src/components/ui/FailureView';
import { buildFailure, failureReason } from '@/src/utils/failure';
import { FAILURE_COPY } from '@/src/utils/failureCopy';

// Founder-only screen: five cards, then the funnel. A card is here only if
// it points at something the founder can do (see FOUNDER_CARDS). Every
// number comes from get_founder_kpis() (db/migration_v238.sql) — computed
// server-side, test/demo businesses already excluded, founder-gated in SQL.
// The derivations live in src/utils/founderKpis.ts and are unit-tested.
//
// Refetches on every focus so re-opening the screen always shows "now".
export function FounderDashboard() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);

  const [kpis, setKpis] = useState<FounderKpis | null>(null);
  const [inviteInstallsFallback, setInviteInstallsFallback] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [logOpen, setLogOpen] = useState(false);

  useFocusEffect(useCallback(() => {
    let cancelled = false;
    (async () => {
      try {
        const [k, inv] = await Promise.all([
          withTimeout(supabase.rpc('get_founder_kpis')),
          // Only a fallback for a server that predates migration_v238.
          withTimeout(supabase.rpc('get_founder_invite_installs')),
        ]);
        if (k.error) throw k.error;
        if (cancelled) return;
        setKpis(k.data as FounderKpis);
        setInviteInstallsFallback(inv.error ? null : Number(inv.data ?? 0));
        setError(null);
      } catch (err) {
        // failure: speaks — the screen shows the sentence with a Réessayer
        if (!cancelled) setError(translateError(err, "Le chargement n'a pas abouti."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [reloadToken]));

  const reload = () => setReloadToken(t => t + 1);

  if (!kpis) {
    return (
      <DataState
        status={error ? 'error' : loading ? 'loading' : 'ready'}
        isEmpty
        skeleton={<SkeletonKpiGrid />}
        empty={error ? (
          <View style={styles.errorBox}>
            <Text variant="bodySmall" color="secondary">{error}</Text>
            <Pressable onPress={reload} style={styles.retry}>
              <Text variant="label" color="primary">Réessayer</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.errorBox}>
            <Text variant="bodySmall" color="secondary">Aucune donnée pour le moment.</Text>
            <Pressable onPress={reload} style={styles.retry}>
              <Text variant="label" color="primary">Actualiser</Text>
            </Pressable>
          </View>
        )}
      >
        {null}
      </DataState>
    );
  }

  const steps = funnelSteps(kpis.funnel);

  const renderCard = (key: FounderCardKey) => {
    switch (key) {
      case 'commerces_actifs': {
        const c = commercesActifsCard(kpis);
        const max = Math.max(1, ...c.bars);
        return (
          <Card key={key} title="Commerces actifs cette semaine" styles={styles}>
            <Text variant="amount">{c.current}</Text>
            <TrendLine trend={c.trend} palette={palette} />
            <Text variant="caption" color="secondary" style={styles.mt1}>{c.caption}</Text>
            <View style={styles.bars}>
              {c.bars.map((v, i) => (
                <View
                  key={i}
                  style={[styles.bar, {
                    height: 4 + (v / max) * 32,
                    backgroundColor: i === c.bars.length - 1 ? palette.textPrimary : palette.border,
                  }]}
                />
              ))}
            </View>
            <Text variant="caption" color="secondary">8 dernières semaines</Text>
            <Hint text={c.hint} styles={styles} />
          </Card>
        );
      }
      case 'retention': {
        const c = retentionCard(kpis);
        return (
          <Card key={key} title="Les commerces reviennent-ils ?" styles={styles}>
            {c.rows.map((row, i) => (
              <View key={row.label} style={[styles.rateRow, i > 0 && styles.divider]}>
                <View style={{ flex: 1 }}>
                  <Text variant="bodySmall">{row.label}</Text>
                  <Text variant="caption" color="secondary">{row.caption}</Text>
                  <TrendLine trend={row.trend} palette={palette} />
                </View>
                <Text variant="h4" style={row.status ? { color: healthColor(palette, row.status) } : undefined}>
                  {formatPct(row.pct)}
                </Text>
              </View>
            ))}
            <Pressable
              onPress={() => router.push('/(app)/founder-kpi/vendeurs?filtre=perdus')}
              style={({ pressed }) => [styles.link, pressed && { opacity: 0.6 }]}
              accessibilityRole="button"
            >
              <Text variant="label" color="primary">{c.lostLabel} ›</Text>
            </Pressable>
            <Hint text={c.hint} styles={styles} />
          </Card>
        );
      }
      case 'activation': {
        const c = activationCard(kpis);
        return (
          <Card key={key} title="Premier usage dans les 24 h" styles={styles}>
            <Text variant="amount" style={c.status ? { color: healthColor(palette, c.status) } : undefined}>
              {formatPct(c.pct)}
            </Text>
            <Text variant="caption" color="secondary">des nouveaux commerces notent une vente ou une dette en moins de 24 h</Text>
            <TrendLine trend={c.trend} palette={palette} />
            <Text variant="caption" color="secondary" style={styles.mt1}>{c.caption}</Text>
            <Hint text={c.hint} styles={styles} />
          </Card>
        );
      }
      case 'parrainage': {
        const c = parrainageCard(kpis, inviteInstallsFallback);
        return (
          <Card key={key} title="Parrainage" styles={styles}>
            <Text variant="amount">{c.installs === null ? '—' : c.installs}</Text>
            <Text variant="caption" color="secondary">installs par invitation</Text>
            <TrendLine trend={c.trend} palette={palette} />
            <Text variant="caption" color="secondary" style={styles.mt1}>{c.caption}</Text>
            <Hint text={c.hint} styles={styles} />
          </Card>
        );
      }
      case 'prospection': {
        const c = prospectionCard(kpis);
        return (
          <Card
            key={key}
            title="Prospection"
            styles={styles}
            action={(
              <Pressable
                onPress={() => { haptics.tap(); setLogOpen(true); }}
                style={styles.plus}
                accessibilityRole="button"
                accessibilityLabel="Noter un contact"
                hitSlop={8}
              >
                <Text variant="h4" color="primary">+</Text>
              </Pressable>
            )}
          >
            <Text variant="amount">{c.thisWeek}</Text>
            <Text variant="caption" color="secondary">{c.caption}</Text>
            <TrendLine trend={c.trend} palette={palette} />
            <Hint text={c.hint} styles={styles} />
          </Card>
        );
      }
    }
  };

  return (
    <View>
      {FOUNDER_CARDS.map(renderCard)}

      <View style={styles.section}>
        <Text variant="label" style={styles.sectionTitle}>Du téléchargement au premier usage</Text>
        <Text variant="caption" color="secondary" style={styles.note}>Appareils ouverts ces 30 derniers jours.</Text>
        {kpis.funnel.devices_all_time === 0 ? (
          <Text variant="caption" color="secondary" style={styles.note}>
            Les installations et codes sont enregistrés à partir de cette version de l'app — l'entonnoir se remplit avec les prochains installés.
          </Text>
        ) : null}
        {steps.map((s, i) => (
          <View key={s.key} style={[styles.funnelRow, i > 0 && styles.divider]}>
            <View style={{ flex: 1 }}>
              <Text variant="bodySmall">{s.label}</Text>
              {i > 0 ? (
                <Text variant="caption" color="secondary">médiane depuis l'étape précédente : {formatDuration(s.medianFromPreviousS)}</Text>
              ) : null}
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text variant="label">{s.count}</Text>
              {i > 0 ? <Text variant="caption" color="secondary">{formatPct(s.conversionPct)}</Text> : null}
            </View>
          </View>
        ))}
      </View>

      <OutreachSheet
        visible={logOpen}
        onClose={() => setLogOpen(false)}
        onSaved={() => { setLogOpen(false); reload(); }}
        styles={styles}
      />
    </View>
  );
}

// ─── Outreach sheet ──────────────────────────────────────────────────────

function OutreachSheet({ visible, onClose, onSaved, styles }: {
  visible: boolean;
  onClose: () => void;
  onSaved: () => void;
  styles: ReturnType<typeof makeStyles>;
}) {
  const { palette } = useTheme();
  const [name, setName] = useState('');
  const [channel, setChannel] = useState<OutreachChannel>('whatsapp');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const { error } = await withTimeout(supabase.rpc('log_founder_outreach', outreachParams({ channel, name, note })));
      if (error) throw error;
      haptics.success();
      setName(''); setNote(''); setChannel('whatsapp');
      onSaved();
    } catch (err) {
      // failure: speaks — failure alert, the sheet stays open with what was typed
      haptics.error();
      showFailureAlert(buildFailure({
        what: FAILURE_COPY.outreachNotLogged.what,
        why: failureReason(err),
        action: { label: 'Retour', onPress: () => {} },
      }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormSheet
      visible={visible}
      onClose={onClose}
      title="Noter un contact"
      footer={(
        <View style={styles.sheetFooter}>
          <Button label="Enregistrer" onPress={save} loading={saving} loadingLabel="Enregistrement" fullWidth />
        </View>
      )}
    >
      <Input label="Nom (facultatif)" value={name} onChangeText={setName} placeholder="Ex. Mariama, boutique du marché" />
      <Text variant="label" style={styles.fieldLabel}>Comment ?</Text>
      <View style={styles.chips}>
        {OUTREACH_CHANNELS.map(c => {
          const active = c.key === channel;
          return (
            <Pressable
              key={c.key}
              onPress={() => setChannel(c.key)}
              style={[styles.chip, active && { backgroundColor: palette.textPrimary, borderColor: palette.textPrimary }]}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
            >
              <Text variant="bodySmall" style={active ? { color: palette.textInverse } : undefined}>{c.label}</Text>
            </Pressable>
          );
        })}
      </View>
      <Input label="Note (facultatif)" value={note} onChangeText={setNote} placeholder="Ce qu'elle a répondu" multiline />
    </FormSheet>
  );
}

// ─── Building blocks ─────────────────────────────────────────────────────

function healthColor(palette: Palette, status: HealthStatus | null): string {
  if (status === 'green') return palette.healthGreen;
  if (status === 'yellow') return palette.healthYellow;
  if (status === 'red') return palette.healthRed;
  return palette.textDisabled;
}

function TrendLine({ trend, palette }: { trend: Trend | null; palette: Palette }) {
  if (!trend) return null;
  const color = trend.dir === 'up' ? palette.healthGreen : trend.dir === 'down' ? palette.healthRed : palette.textSecondary;
  const arrow = trend.dir === 'up' ? '▲' : trend.dir === 'down' ? '▼' : '■';
  return (
    <Text variant="caption" style={{ color, marginTop: spacing[1] }}>{arrow} {trend.label}</Text>
  );
}

function Hint({ text, styles }: { text: string; styles: ReturnType<typeof makeStyles> }) {
  return <Text variant="caption" color="secondary" style={styles.hint}>{text}</Text>;
}

function Card({ title, children, action, styles }: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text variant="label" style={{ flex: 1 }}>{title}</Text>
        {action}
      </View>
      {children}
    </View>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    section: { marginBottom: spacing[6] },
    sectionTitle: { marginBottom: spacing[1] },
    card: {
      backgroundColor: p.background,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: p.border,
      padding: spacing[4],
      marginBottom: spacing[3],
    },
    cardHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: spacing[2],
    },
    plus: {
      width: 32,
      height: 32,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: p.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    bars: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: spacing[1],
      height: 40,
      marginTop: spacing[3],
      marginBottom: spacing[1],
    },
    bar: { flex: 1, borderRadius: 2 },
    rateRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing[3],
      paddingVertical: spacing[2],
    },
    divider: { borderTopWidth: 1, borderTopColor: p.border },
    link: { paddingVertical: spacing[3] },
    hint: { marginTop: spacing[3], lineHeight: 18 },
    funnelRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: spacing[2],
      gap: spacing[3],
    },
    note: { marginBottom: spacing[2] },
    mt1: { marginTop: spacing[1] },
    fieldLabel: { marginTop: spacing[4], marginBottom: spacing[2] },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2], marginBottom: spacing[4] },
    chip: {
      borderWidth: 1,
      borderColor: p.border,
      borderRadius: radius.full,
      paddingHorizontal: spacing[3],
      paddingVertical: spacing[2],
    },
    sheetFooter: { padding: spacing[4] },
    errorBox: { padding: spacing[3], gap: spacing[2] },
    retry: { paddingVertical: spacing[2] },
  });
}
