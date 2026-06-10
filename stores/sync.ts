import { create } from 'zustand';
import { getQueueCount } from '@/lib/db';
import { drainQueue, type SyncResult } from '@/lib/sync';

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
    const count = await getQueueCount();
    set({ syncing: false, lastResult: result, pendingCount: count });
    return result;
  },

  reset: () => set({ pendingCount: 0, syncing: false, lastResult: null }),
}));
