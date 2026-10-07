import { appAlert } from '@/src/utils/appAlert';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useTheme, spacing, radius } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { Text } from '@/src/components/ui/Text';
import { Button } from '@/src/components/ui/Button';
import { loadRefusedOps, type RefusedOp } from '@/lib/pendingOverlay';
import { enqueue, deleteQueueItem } from '@/lib/db';
import { useAuthStore } from '@/stores/auth';
import { useSyncStore } from '@/stores/sync';
import { useInFlight } from '@/src/hooks/useInFlight';

// The failure surface for the outbox. A record that could not be saved on the
// server — a real refusal (failed_permanent), or a row that can no longer be read
// on this phone (failed_corrupt) — is NEVER counted in the numbers (a refused sale
// is not revenue), but it must never vanish either. It says what it was, why it
// failed (the server's own French sentence), and what she can do: Réessayer
// (same payload, same idempotency key — a clean second try, or a dedup if the first
// somehow landed) or Abandonner (an explicit, confirmed let-go). Covers EVERY kind
// of queued record (sales, credits, payments, expenses, products, stock, supplier
// money), not just sales. Mounted on Accueil, Ventes and Rapports.
const COLLAPSED_VISIBLE = 2;

export function RefusedOpsNotice() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const businessId = useAuthStore(s => s.session?.activeBusiness?.id ?? null);
  const lastResult = useSyncStore(s => s.lastResult);
  const failedCount = useSyncStore(s => s.failedCount);
  const [ops, setOps] = useState<RefusedOp[]>([]);
  const [expanded, setExpanded] = useState(false);

  const reload = useCallback(async () => {
    try { setOps(await loadRefusedOps(businessId)); } catch { /* the notice is best-effort */ }
    void useSyncStore.getState().refreshCount().catch(() => { /* counter only */ });
  }, [businessId]);

  useFocusEffect(useCallback(() => { void reload(); }, [reload]));
  useEffect(() => { void reload(); }, [reload, lastResult, failedCount]);

  if (ops.length === 0) return null;
  const shown = expanded ? ops : ops.slice(0, COLLAPSED_VISIBLE);
  return (
    <View style={styles.wrap}>
      {shown.map(op => <RefusedRow key={op.id} op={op} onChanged={reload} palette={palette} styles={styles} />)}
      {ops.length > COLLAPSED_VISIBLE && (
        <Pressable onPress={() => setExpanded(e => !e)} hitSlop={8} accessibilityRole="button">
          <Text variant="caption" style={{ color: palette.textSecondary, textAlign: 'center' }}>
            {expanded ? 'Voir moins' : `Voir les ${ops.length} enregistrements non envoyés`}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

function RefusedRow({ op, onChanged, palette, styles }: {
  op: RefusedOp; onChanged: () => void; palette: Palette; styles: ReturnType<typeof makeStyles>;
}) {
  const [busy, run] = useInFlight();
  const retry = () => run(async () => {
    // Same payload, same idempotency key: if the first attempt left nothing on
    // the server, this is a clean second try; if it somehow did, the key dedups.
    await enqueue(op.operation, JSON.parse(op.payload));
    await deleteQueueItem(op.id);
    useSyncStore.getState().kick();
    onChanged();
  });
  const dismiss = () => appAlert(
    `Abandonner ${op.thisOne} ?`,
    'Rien ne sera enregistré et cela disparaîtra de la liste.',
    [
      { text: 'Annuler', style: 'cancel' },
      { text: 'Abandonner', style: 'destructive', onPress: () => { void run(async () => { await deleteQueueItem(op.id); onChanged(); }); } },
    ],
  );
  return (
    <View style={styles.row}>
      <Text variant="label" style={{ color: palette.textPrimary }}>
        {op.unrecorded} — {op.reason}
      </Text>
      <View style={styles.actions}>
        {op.retryable && <Button label="Réessayer" loadingLabel="Envoi" loading={busy} onPress={retry} size="sm" variant="outline" />}
        <Button label="Abandonner" onPress={dismiss} disabled={busy} size="sm" variant="ghost" />
      </View>
    </View>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    wrap: { gap: spacing[2], paddingHorizontal: spacing[5], paddingTop: spacing[3] },
    row: { backgroundColor: p.warningLight, borderRadius: radius.md, padding: spacing[3], gap: spacing[2] },
    actions: { flexDirection: 'row', gap: spacing[2] },
  });
}
