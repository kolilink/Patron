import { appAlert } from '@/src/utils/appAlert';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
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

// "Vente non enregistrée — <raison du serveur>". A refused operation (the
// server answered with a real rejection, not a network problem) is never
// counted in the reports — a refused sale is not revenue — but it must not
// vanish either: the ventes list still shows it, and this notice says why it
// was refused and lets her try again or let it go.

const NOUN: Record<string, string> = {
  Vente: 'Vente non enregistrée', Crédit: 'Crédit non enregistré',
  Paiement: 'Paiement non enregistré', Livraison: 'Livraison non enregistrée', Annulation: 'Annulation non enregistrée', Opération: 'Opération non enregistrée',
};

export function RefusedOpsNotice() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const businessId = useAuthStore(s => s.session?.activeBusiness?.id ?? null);
  const lastResult = useSyncStore(s => s.lastResult);
  const [ops, setOps] = useState<RefusedOp[]>([]);

  const reload = useCallback(async () => {
    try { setOps(await loadRefusedOps(businessId)); } catch { /* the notice is best-effort */ }
  }, [businessId]);

  useFocusEffect(useCallback(() => { void reload(); }, [reload]));
  useEffect(() => { void reload(); }, [reload, lastResult]);

  if (ops.length === 0) return null;
  return (
    <View style={styles.wrap}>
      {ops.map(op => <RefusedRow key={op.id} op={op} onChanged={reload} palette={palette} styles={styles} />)}
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
    `Abandonner cette ${op.label.toLowerCase()} ?`,
    'Elle ne sera pas enregistrée et disparaîtra de la liste.',
    [
      { text: 'Annuler', style: 'cancel' },
      { text: 'Abandonner', style: 'destructive', onPress: () => { void run(async () => { await deleteQueueItem(op.id); onChanged(); }); } },
    ],
  );
  return (
    <View style={styles.row}>
      <Text variant="label" style={{ color: palette.textPrimary }}>
        {NOUN[op.label] ?? NOUN.Opération} — {op.reason}
      </Text>
      <View style={styles.actions}>
        <Button label="Réessayer" loadingLabel="Envoi" loading={busy} onPress={retry} size="sm" variant="outline" />
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
