// ONE app-wide connectivity truth.
//
// Initialised at startup (app/_layout.tsx awaits initConnectivity() before the
// first screen can paint) and kept live by a NetInfo listener, so the app
// already KNOWS whether it is offline when a screen renders — connectivity is
// never "discovered" through a failed request or a 12–15s timeout.
//
// "Offline" here means ONLY the device reports no network interface at all
// (airplane mode, no signal, Wi-Fi off): NetInfo `isConnected === false`.
// Deliberately NOT `isInternetReachable === false` — that one probes a
// third-party URL and reads false on networks where it is blocked even though
// our own backend is reachable; treating it as offline would cut the app off
// from Supabase. A dead/captive network that still reports "connected" keeps
// going through the existing withTimeout() fallbacks.
//
// lib/supabase.ts consults isKnownOffline() so every network call (stores,
// screens, RPCs, auth) is SKIPPED outright while offline — it rejects
// immediately with the same error a real dead network produces, so every
// existing cache/queue fallback runs instantly instead of waiting out a timeout.
import { create } from 'zustand';

interface ConnectivityState {
  online: boolean;
  /** false until NetInfo has answered once (or the startup cap elapsed). */
  known: boolean;
  /** How many screens currently show their own "offline" state (OfflineNotice mounted). */
  offlineViews: number;
  /** Bumped on every offline → online transition; OfflineNotice retries on it. */
  reconnectTick: number;
}

export const useConnectivityStore = create<ConnectivityState>(() => ({
  online: true,
  known: false,
  offlineViews: 0,
  reconnectTick: 0,
}));

export function isKnownOffline(): boolean {
  const s = useConnectivityStore.getState();
  return s.known && !s.online;
}

/** Pure: does a NetInfo snapshot mean "no network at all"? */
export function isNetInfoOffline(state: { isConnected?: boolean | null } | null | undefined): boolean {
  return state?.isConnected === false;
}

export function applyNetInfoState(state: { isConnected?: boolean | null } | null | undefined) {
  const online = !isNetInfoOffline(state);
  const prev = useConnectivityStore.getState();
  useConnectivityStore.setState({
    online,
    known: true,
    reconnectTick: prev.known && !prev.online && online ? prev.reconnectTick + 1 : prev.reconnectTick,
  });
}

let initPromise: Promise<void> | null = null;

/**
 * Idempotent. Resolves once the first reading is in (or after `capMs`, so a
 * slow native bridge can never hold the app hostage — it then stays optimistic
 * "online" until the listener's first event). Never rejects.
 */
export function initConnectivity(capMs = 1200): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    let NetInfo: typeof import('@react-native-community/netinfo').default;
    try {
      NetInfo = require('@react-native-community/netinfo').default;
    } catch {
      return; // NetInfo unavailable (tests / web stub): stay optimistic
    }
    try {
      NetInfo.addEventListener(applyNetInfoState);
      await Promise.race([
        NetInfo.fetch().then(applyNetInfoState),
        new Promise<void>(resolve => setTimeout(resolve, capMs)),
      ]);
    } catch {
      /* stay optimistic */
    }
  })();
  return initPromise;
}
