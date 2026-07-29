import { useEffect, useRef } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing } from '@/src/theme';
import { useSyncStore } from '@/stores/sync';

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
// still want it) — just "Hors ligne", nothing else. Also suppressed
// whenever there are pending sync operations: the global SyncBanner
// ((app)/_layout.tsx) is already on screen at that point and says the same
// thing, so showing both stacked banners was redundant clutter.
export function OfflineNotice({ offlineSince: _offlineSince, onRetry }: Props) {
  const { palette } = useTheme();
  const pendingCount = useSyncStore(s => s.pendingCount);
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

  if (pendingCount > 0) return null;

  return (
    <View style={[styles.bar, { backgroundColor: palette.warningLight }]}>
      <Text variant="caption" style={{ color: palette.warning }}>Hors ligne</Text>
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
