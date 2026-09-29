import { useEffect, useRef } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing } from '@/src/theme';

interface Props {
  offlineSince: number | null;
  /**
   * The same fetch the screen already runs on mount/focus — called again on
   * an interval while this banner is visible. Each store's own success path
   * already flips its `offline` flag back to false, which is what makes
   * this banner unmount itself the instant a retry lands; nothing here
   * needs to know about that, it just needs to keep asking. Without this, a
   * screen's offline flag only ever clears when the user happens to leave
   * and re-enter it — real Wi-Fi coming back does nothing on its own. See
   * CLAUDE.md's "Offline read caches" for the fallback this closes the loop
   * on. Optional only so a screen mid-migration can omit it temporarily —
   * every real call site should pass one.
   */
  onRetry?: () => void | Promise<void>;
}

const RETRY_INTERVAL_MS = 15000;

// offlineSince is intentionally unused in the label now (kept in the props
// contract since every call site already passes it, and future callers may
// still want it) — just "Hors ligne", nothing else.
//
// §8 of the offline-first rewrite: recolored from amber (palette.warning)
// to the same quiet gray treatment as SyncStatusLine, and the old
// suppress-while-SyncBanner-is-up condition (`if (pendingCount > 0) return
// null`) is dropped. That condition relied on SyncBanner and this notice
// being mutually exclusive by construction — SyncBanner only ever rendered
// when pendingCount > 0, this only when pendingCount === 0 — which broke
// the moment SyncStatusLine (SyncBanner's replacement) started rendering
// in the CLEAN state too ("Tout est synchronisé ✓"), a state this notice
// can legitimately coexist with: a screen's own read can be stale
// (offline: true, this notice's actual trigger) while the write queue is
// genuinely empty (pendingCount === 0, SyncStatusLine's clean state) — two
// different, both-true signals, not a contradiction, once neither is
// alarm-colored. Keeping the old suppression would have hidden a real,
// separate signal (this screen's own data may be stale) for no reason
// other than an accident of the old component's specific trigger shape.
export function OfflineNotice({ offlineSince: _offlineSince, onRetry }: Props) {
  const { palette } = useTheme();
  const onRetryRef = useRef(onRetry);
  onRetryRef.current = onRetry;

  useEffect(() => {
    if (!onRetryRef.current) return;
    const fire = () => {
      // Skip a retry while backgrounded — no point spending a request (or
      // battery) on a screen nobody can see the result of right now.
      if (AppState.currentState === 'active') void onRetryRef.current?.();
    };
    const id = setInterval(fire, RETRY_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <View style={[styles.bar, { backgroundColor: palette.background }]}>
      <Text variant="caption" style={{ color: palette.textSecondary }}>Hors ligne</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing[5],
    paddingVertical: spacing[1],
  },
});
