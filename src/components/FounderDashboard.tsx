import { useCallback, useMemo, useState } from 'react';
import { Alert, Linking, Pressable, StyleSheet, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Text } from '@/src/components/ui/Text';
import { SkeletonKpiGrid } from '@/src/components/ui/SkeletonPlaceholder';
import { useTheme, spacing, radius } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { supabase } from '@/lib/supabase';
import { withTimeout } from '@/lib/sync';
import { translateError } from '@/lib/errors';
import {
  TARGETS,
  formatDuration,
  formatPct,
  funnelSteps,
  getHealthStatus,
  identifyBottleneck,
  northStar,
  pct,
  referral,
  type CallListRow,
  type CallLists,
  type FounderKpis,
  type HealthStatus,
} from '@/src/utils/founderKpis';
import { showFailureAlert } from '@/src/components/ui/FailureView';
import { buildFailure, failureReason } from '@/src/utils/failure';
import { FAILURE_COPY } from '@/src/utils/failureCopy';

// Founder-only measurement screen — the 7 blocks of the measurement spec
// (docs/measurement.md): North Star, funnel, activation + TTFV, retention,
// the four referral numbers, the "frein actuel" paragraph, and the three
// WhatsApp call lists.
//
// Every number comes from get_founder_kpis() / get_founder_call_lists()
// (db/migration_v209.sql) — computed server-side, is_test traffic already
// excluded, founder-gated in SQL. This component only fetches and renders;
// the derivations and the frein rule live in src/utils/founderKpis.ts.
//
// Refetches on every focus so re-opening the screen always shows "now".
// Never renders an empty screen: skeleton while loading, an error with a
// retry, and "—" plus a short reason for any block without data yet.
export function FounderDashboard() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);

  const [kpis, setKpis] = useState<FounderKpis | null>(null);
  const [lists, setLists] = useState<CallLists | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useFocusEffect(useCallback(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [k, l] = await Promise.all([
          withTimeout(supabase.rpc('get_founder_kpis')),
          withTimeout(supabase.rpc('get_founder_call_lists')),
        ]);
        if (k.error) throw k.error;
        if (l.error) throw l.error;
        if (cancelled) return;
        setKpis(k.data as FounderKpis);
        setLists(l.data as CallLists);
      } catch (err) {
        if (!cancelled) setError(translateError(err, 'Erreur de chargement'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [reloadToken]));

  const reload = () => setReloadToken(t => t + 1);

  const markTest = (row: CallListRow) => {
    Alert.alert(
      'Marquer comme test ?',
      `« ${row.business_name ?? 'Ce commerce'} » sera exclu de tous les chiffres.`,
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Marquer test',
          onPress: async () => {
            const { error: e } = await supabase.rpc('set_business_is_test', { p_business_id: row.business_id, p_is_test: true });
            if (e) showFailureAlert(buildFailure({ what: FAILURE_COPY.testFlagNotChanged.what, why: failureReason(e), action: { label: 'Retour', onPress: () => {} } }));
            else reload();
          },
        },
      ],
    );
  };

  if (loading && !kpis) return <SkeletonKpiGrid />;

  if (error && !kpis) {
    return (
      <View style={styles.errorBox}>
        <Text variant="bodySmall" color="secondary">{error}</Text>
        <Pressable onPress={reload} style={styles.retry}>
          <Text variant="label" color="primary">Réessayer</Text>
        </Pressable>
      </View>
    );
  }

  if (!kpis) {
    return (
      <View style={styles.errorBox}>
        <Text variant="bodySmall" color="secondary">Aucune donnée pour le moment.</Text>
        <Pressable onPress={reload} style={styles.retry}>
          <Text variant="label" color="primary">Actualiser</Text>
        </Pressable>
      </View>
    );
  }

  const ns = northStar(kpis.north_star);
  const steps = funnelSteps(kpis.funnel);
  const ref = referral(kpis.referral);
  const activationPct = pct(kpis.activation.activated, kpis.activation.cohort);
  const under24hPct = pct(kpis.activation.ttfv_under_24h, kpis.activation.ttfv_commerce_n);
  const w1Pct = pct(kpis.retention.w1_retained, kpis.retention.w1_cohort);
  const w4Pct = pct(kpis.retention.w4_retained, kpis.retention.w4_cohort);
  const frein = identifyBottleneck(kpis);
  const trendMax = Math.max(1, ...ns.trend);

  return (
    <View>
      {/* 1. North Star */}
      <Section title="North Star" styles={styles}>
        <View style={[styles.hero, { borderLeftColor: healthColor(palette, getHealthStatus(ns.ratePct, TARGETS.northStarRate)) }]}>
          <Text variant="amount">{ns.current}</Text>
          <Text variant="caption" color="secondary">Commerces actifs / semaine (≥ 1 action en 7 j)</Text>
          <Text variant="caption" color="secondary" style={styles.mt1}>
            {ns.delta === null ? '—' : `${ns.delta >= 0 ? '+' : ''}${ns.delta} vs semaine précédente`}
            {` · ${formatPct(ns.ratePct)} des ${kpis.north_star.total_real_businesses} commerces réels`}
          </Text>
          <View style={styles.trend}>
            {ns.trend.map((v, i) => (
              <View
                key={i}
                style={[styles.trendBar, {
                  height: 4 + (v / trendMax) * 32,
                  backgroundColor: i === ns.trend.length - 1 ? palette.textPrimary : palette.border,
                }]}
              />
            ))}
          </View>
          <Text variant="caption" color="secondary">8 dernières semaines</Text>
        </View>
      </Section>

      {/* 2. Funnel */}
      <Section title="Entonnoir — installés sur 30 j" styles={styles}>
        {kpis.funnel.devices_all_time === 0 ? (
          <Text variant="caption" color="secondary" style={styles.note}>
            Les installations et codes sont enregistrés à partir de cette version de l'app — l'entonnoir se remplit avec les prochains installés.
          </Text>
        ) : null}
        {steps.map((s, i) => (
          <View key={s.key} style={[styles.funnelRow, i > 0 && styles.funnelDivider]}>
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
      </Section>

      {/* 3. Activation + TTFV */}
      <Section title="Activation + TTFV" styles={styles}>
        <View style={styles.grid}>
          <StatCard
            label="Activation (créés en 30 j)"
            value={formatPct(activationPct)}
            caption={`${kpis.activation.activated} / ${kpis.activation.cohort}`}
            status={getHealthStatus(activationPct, TARGETS.activation)}
            palette={palette} styles={styles}
          />
          <StatCard
            label="TTFV médian (installation → 1ʳᵉ valeur)"
            value={formatDuration(kpis.funnel.ttfv_install_median_s)}
            caption={`n = ${kpis.funnel.ttfv_install_n} · visé < 5 min`}
            status={ttfvStatus(kpis.funnel.ttfv_install_median_s)}
            palette={palette} styles={styles}
          />
          <StatCard
            label="Création → 1ʳᵉ valeur (90 j)"
            value={formatDuration(kpis.activation.ttfv_commerce_median_s)}
            caption={`n = ${kpis.activation.ttfv_commerce_n}`}
            status={ttfvStatus(kpis.activation.ttfv_commerce_median_s)}
            palette={palette} styles={styles}
          />
          <StatCard
            label="1ʳᵉ valeur en < 24 h"
            value={formatPct(under24hPct)}
            caption={`visé ${TARGETS.ttfvUnder24h.green} %`}
            status={getHealthStatus(under24hPct, TARGETS.ttfvUnder24h)}
            palette={palette} styles={styles}
          />
        </View>
      </Section>

      {/* 4. Retention */}
      <Section title="Rétention des commerces activés" styles={styles}>
        <View style={styles.grid}>
          <StatCard
            label="Semaine 1"
            value={formatPct(w1Pct)}
            caption={`${kpis.retention.w1_retained} / ${kpis.retention.w1_cohort} · visé ${TARGETS.week1.green} %`}
            status={getHealthStatus(w1Pct, TARGETS.week1)}
            palette={palette} styles={styles}
          />
          <StatCard
            label="Semaine 4"
            value={formatPct(w4Pct)}
            caption={`${kpis.retention.w4_retained} / ${kpis.retention.w4_cohort} · visé ${TARGETS.week4.green} %`}
            status={getHealthStatus(w4Pct, TARGETS.week4)}
            palette={palette} styles={styles}
          />
        </View>
      </Section>

      {/* 5. Referral — the four numbers */}
      <Section title="Parrainage — 30 j" styles={styles}>
        <View style={styles.grid}>
          <StatCard
            label="Taux de partage"
            value={formatPct(ref.shareRatePct)}
            caption={`${kpis.referral.sharing_30d} / ${kpis.referral.active_30d} commerces actifs`}
            status={getHealthStatus(ref.shareRatePct, TARGETS.shareRate)}
            palette={palette} styles={styles}
          />
          <StatCard
            label="Conversion des invitations"
            value={formatPct(ref.conversionPct)}
            caption={`${kpis.referral.invites_used_30d} / ${kpis.referral.invites_created_30d} liens`}
            status={getHealthStatus(ref.conversionPct, TARGETS.referralConversion)}
            palette={palette} styles={styles}
          />
          <StatCard
            label="K-factor"
            value={ref.kFactor === null ? '—' : ref.kFactor.toFixed(2)}
            caption={`${kpis.referral.referred_signups_30d} commerces parrainés`}
            status={null}
            palette={palette} styles={styles}
          />
          <StatCard
            label="Qualité des parrainés"
            value={formatPct(ref.referredActivationPct)}
            caption={`activés · organiques ${formatPct(ref.organicActivationPct)} (n = ${kpis.referral.referred_n})`}
            status={null}
            palette={palette} styles={styles}
          />
        </View>
      </Section>

      {/* 6. Frein actuel */}
      <Section title="Frein actuel" styles={styles}>
        <Text variant="bodySmall" style={styles.frein}>{frein.sentence}</Text>
      </Section>

      {/* 7. WhatsApp call lists */}
      <Section title="Appels WhatsApp de la semaine" styles={styles}>
        <Text variant="caption" color="secondary" style={styles.note}>
          Touchez une ligne pour ouvrir WhatsApp avec un message prêt. Appui long : marquer comme test.
        </Text>
        <CallList title="Bienvenue — nouveaux (7 j)" kind="welcome" rows={lists?.welcome ?? []} onLongPress={markTest} styles={styles} />
        <CallList title="Entretien — activés, silencieux 7 j" kind="interview" rows={lists?.interview ?? []} onLongPress={markTest} styles={styles} />
        <CallList title="Parrainage — très actifs" kind="referral" rows={lists?.referral ?? []} onLongPress={markTest} styles={styles} />
      </Section>
    </View>
  );
}

// ─── WhatsApp lists ──────────────────────────────────────────────────────

type ListKind = 'welcome' | 'interview' | 'referral';

function firstName(row: CallListRow): string {
  return (row.owner_name ?? '').trim().split(/\s+/)[0] ?? '';
}

function whatsappMessage(kind: ListKind, row: CallListRow): string {
  const who = firstName(row);
  const hello = who ? `Bonjour ${who}` : 'Bonjour';
  const shop = row.business_name ? ` « ${row.business_name} »` : '';
  if (kind === 'welcome') {
    return `${hello}, ici l'équipe Patron. Merci d'avoir ouvert${shop} ! Voulez-vous qu'on note ensemble votre première vente ou dette ? Ça prend 2 minutes.`;
  }
  if (kind === 'interview') {
    return `${hello}, ici l'équipe Patron. On a vu que vous n'avez pas utilisé Patron ces derniers jours — qu'est-ce qui vous a manqué ? Votre avis nous aide beaucoup.`;
  }
  return `${hello}, ici l'équipe Patron. Vous êtes parmi nos commerçants les plus actifs, merci ! Connaissez-vous un autre commerçant à qui Patron rendrait service ? Vous pouvez l'inviter depuis l'app (Inviter).`;
}

function openWhatsApp(kind: ListKind, row: CallListRow) {
  const digits = (row.owner_phone ?? '').replace(/\D/g, '');
  if (!digits) return;
  const url = `https://wa.me/${digits}?text=${encodeURIComponent(whatsappMessage(kind, row))}`;
  Linking.openURL(url).catch(() => {});
}

function daysAgo(iso: string | null): string {
  if (!iso) return 'jamais';
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return d <= 0 ? "aujourd'hui" : `il y a ${d} j`;
}

function rowMeta(kind: ListKind, row: CallListRow): string {
  if (kind === 'welcome') return `créé ${daysAgo(row.created_at)} · ${row.first_value_at ? '1ʳᵉ valeur ✓' : 'pas encore de vente'}`;
  if (kind === 'interview') return `dernière action ${daysAgo(row.last_action_at)}`;
  return `${row.active_days_7d} j actifs sur 7 · ${row.actions_7d} actions`;
}

function CallList({ title, kind, rows, onLongPress, styles }: {
  title: string;
  kind: ListKind;
  rows: CallListRow[];
  onLongPress: (row: CallListRow) => void;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <View style={styles.list}>
      <Text variant="label" style={styles.listTitle}>{title} · {rows.length}</Text>
      {rows.length === 0 ? (
        <Text variant="caption" color="secondary">Personne cette semaine.</Text>
      ) : rows.map(row => (
        <Pressable
          key={row.business_id}
          onPress={() => openWhatsApp(kind, row)}
          onLongPress={() => onLongPress(row)}
          style={({ pressed }) => [styles.listRow, pressed && { opacity: 0.6 }]}
        >
          <View style={{ flex: 1 }}>
            <Text variant="bodySmall" numberOfLines={1}>
              {row.owner_name || 'Sans nom'} · {row.business_name ?? '—'}
            </Text>
            <Text variant="caption" color="secondary" numberOfLines={1}>{rowMeta(kind, row)}</Text>
          </View>
          <Text variant="caption" color="secondary">{row.owner_phone ?? ''}</Text>
        </Pressable>
      ))}
    </View>
  );
}

// ─── Building blocks ─────────────────────────────────────────────────────

function ttfvStatus(seconds: number | null): HealthStatus | null {
  if (seconds === null) return null;
  if (seconds <= 5 * 60) return 'green';
  if (seconds <= 24 * 3600) return 'yellow';
  return 'red';
}

function healthColor(palette: Palette, status: HealthStatus | null): string {
  if (status === 'green') return palette.healthGreen;
  if (status === 'yellow') return palette.healthYellow;
  if (status === 'red') return palette.healthRed;
  return palette.textDisabled;
}

function Section({ title, children, styles }: {
  title: string;
  children: React.ReactNode;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <View style={styles.section}>
      <Text variant="caption" color="secondary" style={styles.sectionTitle}>{title.toUpperCase()}</Text>
      {children}
    </View>
  );
}

function StatCard({ label, value, caption, status, palette, styles }: {
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
      <Text variant="h4" style={status ? { color } : undefined}>{value}</Text>
      <Text variant="caption" color="secondary" style={styles.mt1}>{label}</Text>
      {caption ? <Text variant="caption" color="secondary">{caption}</Text> : null}
    </View>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    section: {
      marginBottom: spacing[6],
    },
    sectionTitle: {
      marginBottom: spacing[2],
      letterSpacing: 0.5,
    },
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
    hero: {
      backgroundColor: p.background,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: p.border,
      borderLeftWidth: 3,
      padding: spacing[4],
    },
    trend: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: spacing[1],
      height: 40,
      marginTop: spacing[3],
      marginBottom: spacing[1],
    },
    trendBar: {
      flex: 1,
      borderRadius: 2,
    },
    funnelRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: spacing[2],
      gap: spacing[3],
    },
    funnelDivider: {
      borderTopWidth: 1,
      borderTopColor: p.border,
    },
    frein: {
      lineHeight: 20,
    },
    note: {
      marginBottom: spacing[2],
    },
    list: {
      marginTop: spacing[3],
    },
    listTitle: {
      marginBottom: spacing[1],
    },
    listRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing[3],
      paddingVertical: spacing[2],
      borderTopWidth: 1,
      borderTopColor: p.border,
    },
    mt1: {
      marginTop: spacing[1],
    },
    errorBox: {
      padding: spacing[3],
      gap: spacing[2],
    },
    retry: {
      paddingVertical: spacing[2],
    },
  });
}
