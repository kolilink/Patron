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

// The link must stay up this long before the app treats it as "back": rapid
// airplane-mode flapping (or a flaky tower) then coalesces into one reconnect
// instead of a thrash of drains, refetches and indicator flickers.
export const RECONNECT_SETTLE_MS = 700;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

export function applyNetInfoState(state: { isConnected?: boolean | null } | null | undefined) {
  const online = !isNetInfoOffline(state);
  const prev = useConnectivityStore.getState();
  // `online` itself flips immediately both ways — a request must never be sent into
  // a dead link, nor held back after it is alive. Only the SIDE EFFECTS of coming
  // back (reconnectTick: drain, refetch, warm-up) wait for the link to settle.
  useConnectivityStore.setState({ online, known: true });
  if (!online) {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    return;
  }
  if (prev.known && !prev.online) {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (useConnectivityStore.getState().online) {
        useConnectivityStore.setState(s => ({ reconnectTick: s.reconnectTick + 1 }));
      }
    }, RECONNECT_SETTLE_MS);
  }
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
