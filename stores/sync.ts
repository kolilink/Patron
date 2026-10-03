import { create } from 'zustand';
import { getQueueCount, getFailedQueueCount } from '@/lib/db';
import { drainQueue, type SyncResult } from '@/lib/sync';
// trackEvent (and its transitive posthog import) is safe to depend on
// here — stores/sync.ts is a Zustand store, not a foundational utility
// module every other file (including lib/posthog.ts/lib/analytics.ts
// themselves) imports. lib/sync.ts deliberately does NOT do this itself —
// see SyncHealthEvent's own doc comment there for why that was tried and
// reverted (it crashed 5 unrelated test suites that had no reason to know
// about PostHog the moment they imported lib/sync.ts).
import { trackEvent } from '@/lib/analytics';

interface SyncStore {
  pendingCount: number;
  // Distinct from pendingCount by construction: rows parked as
  // failed_permanent or failed_corrupt have STOPPED retrying — they are not
  // "waiting to sync", so they must never be folded into pendingCount (that
  // drives SyncStatusLine's "X jours sans connexion" copy). This is the quiet
  // §9 number — a state field for the Paramètres/founder surface, not
  // merchant-facing sync noise.
  failedCount: number;
  syncing: boolean;
  lastResult: SyncResult | null;
  // Set whenever a sync pass leaves the queue genuinely empty. No longer
  // drives any UI — the sync line (§8) is silent when online — but kept as
  // the last moment everything was actually confirmed synced (observability).
  // Never set on a pass that still leaves items pending, so it always
  // reflects the last confirmed-synced instant, not just "the last time
  // sync() happened to run."
  lastSyncedAt: string | null;
  refreshCount: () => Promise<void>;
  sync: () => Promise<SyncResult>;
  // Fire-and-forget: tells the drainer "go now" without the caller
  // awaiting anything. This is what §5's write paths call right after
  // enqueueing, instead of the old "try the RPC live, fall back to queue
  // on failure" branch — under the local-write-first model (Decision A),
  // the UI must never wait on this, only on the durable local write.
  // Safe to call redundantly: drainQueue's own _running guard (lib/sync.ts)
  // makes an overlapping call a no-op, and a call on a still-genuinely-
  // offline device just re-confirms that and returns quickly. This is the
  // ONLY place any store should ever trigger a sync pass outside the
  // existing AppState foreground listener — a write path calling the RPC
  // itself directly (the old pattern) would reintroduce the exact
  // two-call-sites split this rework removes.
  kick: () => void;
  reset: () => void;
}

export const useSyncStore = create<SyncStore>((set, get) => ({
  pendingCount: 0,
  failedCount: 0,
  syncing: false,
  lastResult: null,
  lastSyncedAt: null,

  refreshCount: async () => {
    const [count, failedCount] = await Promise.all([getQueueCount(), getFailedQueueCount()]);
    set({ pendingCount: count, failedCount });
    if (count === 0) set({ lastSyncedAt: new Date().toISOString() });
  },

  sync: async () => {
    set({ syncing: true });
    const result = await drainQueue();
    // Best-effort, fire-and-forget — an analytics failure must never
    // affect the sync result itself (same posture trackEvent's own
    // try/catch already guarantees for every other call site in this app).
    for (const event of result.syncHealthEvents) {
      trackEvent(event.name, event.businessId, null, event.metadata);
    }
    const [count, failedCount] = await Promise.all([getQueueCount(), getFailedQueueCount()]);
    set({
      syncing: false,
      lastResult: result,
      pendingCount: count,
      failedCount,
      ...(count === 0 ? { lastSyncedAt: new Date().toISOString() } : {}),
    });
    return result;
  },

  kick: () => {
    // sync() can still reject even with drainQueue's own top-level catch
    // (lib/sync.ts) — getQueueCount() below it, or trackEvent, could
    // theoretically throw too. kick() is called fire-and-forget from
    // every Phase-1 write path right after a LOCAL write already durably
    // succeeded (§5) — an unhandled rejection here must never surface as
    // if that write had failed, so it's swallowed at the source rather
    // than trusting every caller to remember a .catch().
    get().sync().catch(err => console.error('[useSyncStore.kick] sync() rejected', err));
  },

  reset: () => set({ pendingCount: 0, failedCount: 0, syncing: false, lastResult: null, lastSyncedAt: null }),
}));
