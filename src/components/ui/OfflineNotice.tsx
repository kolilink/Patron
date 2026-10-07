import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useConnectivityStore } from '@/lib/connectivity';

interface Props {
  offlineSince: number | null;
  /**
   * The same fetch the screen already runs on mount/focus. Called again on an
   * interval while mounted (a screen's `offline` flag only ever clears when its
   * own fetch succeeds), and immediately when connectivity returns.
   */
  onRetry?: () => void | Promise<void>;
}

const RETRY_INTERVAL_MS = 15000;

/**
 * HEADLESS since the offline-first pass: it renders nothing, so it can never
 * push content around or collide with a header / status bar (the old in-flow
 * "Hors ligne" bar did both). It only (1) tells the app-wide OfflineIndicator
 * overlay that this screen is showing offline data, and (2) keeps the retry
 * loop that clears the screen's offline flag once the network is back.
 * Call sites keep rendering it exactly as before.
 */
export function OfflineNotice({ offlineSince: _offlineSince, onRetry }: Props) {
  const onRetryRef = useRef(onRetry);
  onRetryRef.current = onRetry;
  const reconnectTick = useConnectivityStore(s => s.reconnectTick);

  useEffect(() => {
    useConnectivityStore.setState(s => ({ offlineViews: s.offlineViews + 1 }));
    return () => useConnectivityStore.setState(s => ({ offlineViews: Math.max(0, s.offlineViews - 1) }));
  }, []);

  useEffect(() => {
    if (!onRetryRef.current) return;
    const fire = () => {
      // No point spending a request (or battery) while backgrounded.
      if (AppState.currentState === 'active') void onRetryRef.current?.();
    };
    const id = setInterval(fire, RETRY_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  // Connectivity just came back: retry now instead of waiting for the interval.
  useEffect(() => {
    if (reconnectTick > 0 && AppState.currentState === 'active') void onRetryRef.current?.();
  }, [reconnectTick]);

  return null;
}
