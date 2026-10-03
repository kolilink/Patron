import { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
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
//
// Layout-shift fix: this line sits in the normal flow above <Stack/> in
// app/(app)/_layout.tsx. Returning null (clean) vs rendering a View
// (syncing / 7-day) changed the header's height on every sync-state flip,
// and a fast drain could bounce the whole screen. Two-part fix:
//   (a) debounce BOTH edges — a state change shorter than this never
//       renders, so a sub-second syncing blip (or a momentary clean flash
//       between writes) produces no flicker at all;
//   (b) keep the line mounted and animate its height smoothly instead of
//       mounting/unmounting, so any reflow is a gentle slide, not a jump.
const DEBOUNCE_MS = 500;
const HEIGHT_ANIM_MS = 200;

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

  // (a) Debounce both edges onto a single committed label — a transient
  // state change shorter than DEBOUNCE_MS never reaches the committed
  // value, so the line neither flashes on nor flashes off.
  const [committedLabel, setCommittedLabel] = useState<string | null>(label);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (label === committedLabel) return;
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => setCommittedLabel(label), DEBOUNCE_MS);
    return () => { if (commitTimer.current) clearTimeout(commitTimer.current); };
  }, [label, committedLabel]);

  // (b) Animate the line's height instead of mounting/unmounting it. The
  // inner View is always laid out at full size (so onLayout reports the
  // real target height, insets.top included), and the outer Animated.View
  // clips it to the animated height — zero when clean, full when visible.
  const visible = committedLabel !== null;
  const [barHeight, setBarHeight] = useState(0);
  const height = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (barHeight === 0) return;
    Animated.timing(height, {
      toValue: visible ? barHeight : 0,
      duration: HEIGHT_ANIM_MS,
      useNativeDriver: false,
    }).start();
  }, [visible, barHeight, height]);

  return (
    <Animated.View style={{ height, overflow: 'hidden', backgroundColor: palette.background }}>
      <View
        onLayout={e => setBarHeight(e.nativeEvent.layout.height)}
        style={[
          styles.bar,
          { paddingTop: (isDemoMode ? 0 : insets.top) + spacing[1] },
        ]}
      >
        <Text variant="caption" style={{ color: palette.textSecondary }}>{committedLabel ?? ''}</Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  bar: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: spacing[1],
  },
});
