import { create } from 'zustand';
import { getQueueCount } from '@/lib/db';
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
  syncing: boolean;
  lastResult: SyncResult | null;
  refreshCount: () => Promise<void>;
  sync: () => Promise<SyncResult>;
  reset: () => void;
}

export const useSyncStore = create<SyncStore>((set) => ({
  pendingCount: 0,
  syncing: false,
  lastResult: null,

  refreshCount: async () => {
    const count = await getQueueCount();
    set({ pendingCount: count });
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
    const count = await getQueueCount();
    set({ syncing: false, lastResult: result, pendingCount: count });
    return result;
  },

  reset: () => set({ pendingCount: 0, syncing: false, lastResult: null }),
}));
