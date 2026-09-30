import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useSyncStore } from '@/stores/sync';
import { getQueueSnapshot } from '@/lib/db';
import { computeSyncStatusLabel } from '@/src/components/ui/syncStatusLabel';

// §8 of the offline-first rewrite: the ONE sync-status surface in the
// whole app, replacing the old amber SyncBanner ("N opérations à
// synchroniser" + a tappable "↑ Sync" action). Per the approved spec:
// zero sync noise — no per-record badges, no counts, no alarm colors.
// Small, gray, honest — the actual state-selection logic (the four
// states the spec names) lives in syncStatusLabel.ts, kept out of this
// file specifically so it's unit-testable (see that file's own comment
// for why). Never a Pressable, never an action to tap — there is nothing
// for the merchant to DO here; the drainer already runs on its own
// (kick() from every write, plus the existing AppState foreground
// listener). A manual "sync now" button was part of the old SyncBanner
// and is deliberately not carried forward — it implied the merchant
// needed to do something, which contradicts "never block capture."

export function SyncStatusLine() {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const pendingCount = useSyncStore(s => s.pendingCount);
  const syncing = useSyncStore(s => s.syncing);
  const lastSyncedAt = useSyncStore(s => s.lastSyncedAt);
  const isDemoMode = useAuthStore(s => s.session?.isDemoMode ?? false);

  // Oldest pending item's queued_at — the only way to know whether the
  // 7-day escalation copy applies. Re-checked whenever pendingCount
  // changes (a new item queued, or a drain completed) rather than on a
  // timer, since that's the only thing that can actually change which
  // item is oldest.
  const [oldestQueuedAt, setOldestQueuedAt] = useState<string | null>(null);
  useEffect(() => {
    if (pendingCount === 0) { setOldestQueuedAt(null); return; }
    let cancelled = false;
    void getQueueSnapshot().then(rows => {
      if (cancelled) return;
      const withDate = rows.filter(r => r.queued_at).map(r => r.queued_at as string);
      setOldestQueuedAt(withDate.length > 0 ? withDate.reduce((a, b) => (a < b ? a : b)) : null);
    });
    return () => { cancelled = true; };
  }, [pendingCount]);

  const label = computeSyncStatusLabel({ syncing, pendingCount, lastSyncedAt, oldestQueuedAt });
  if (label === null) return null;

  return (
    <View
      style={[
        styles.bar,
        { paddingTop: (isDemoMode ? 0 : insets.top) + spacing[1], backgroundColor: palette.background },
      ]}
    >
      <Text variant="caption" style={{ color: palette.textSecondary }}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: spacing[1],
  },
});
