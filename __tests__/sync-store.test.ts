// stores/sync.ts's sync() action is the one place SyncHealthEvent records
// from drainQueue (lib/sync.ts) actually become trackEvent() calls — see
// that type's own doc comment for why lib/sync.ts itself can't safely do
// this (importing analytics there crashed 5 unrelated test suites).

const mockDrainQueue = jest.fn();
jest.mock('@/lib/sync', () => ({
  drainQueue: mockDrainQueue,
}));

const mockGetQueueCount = jest.fn().mockResolvedValue(0);
jest.mock('@/lib/db', () => ({
  getQueueCount: mockGetQueueCount,
}));

const mockTrackEvent = jest.fn();
jest.mock('@/lib/analytics', () => ({
  trackEvent: mockTrackEvent,
}));

import { useSyncStore } from '@/stores/sync';

beforeEach(() => {
  jest.clearAllMocks();
  useSyncStore.getState().reset();
});

describe('useSyncStore.sync()', () => {
  it('fires no trackEvent calls when the drain had no sync-health events', async () => {
    mockDrainQueue.mockResolvedValueOnce({ synced: 2, failed: 0, rejectedPayments: [], syncHealthEvents: [] });
    await useSyncStore.getState().sync();
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  it('fires one trackEvent per syncHealthEvent, with the right name/businessId/metadata', async () => {
    mockDrainQueue.mockResolvedValueOnce({
      synced: 0, failed: 2, rejectedPayments: [],
      syncHealthEvents: [
        { name: 'sync_drain_failed_network', businessId: 'biz-1', metadata: { operation: 'submit_sale', attempts: 1 } },
        { name: 'sync_op_failed_permanent', businessId: 'biz-2', metadata: { operation: 'cancel_sale', error: 'x' } },
      ],
    });

    await useSyncStore.getState().sync();

    expect(mockTrackEvent).toHaveBeenCalledTimes(2);
    expect(mockTrackEvent).toHaveBeenCalledWith('sync_drain_failed_network', 'biz-1', null, { operation: 'submit_sale', attempts: 1 });
    expect(mockTrackEvent).toHaveBeenCalledWith('sync_op_failed_permanent', 'biz-2', null, { operation: 'cancel_sale', error: 'x' });
  });

  it('a corrupt event (businessId always null — never known for a corrupt row) is fired correctly', async () => {
    mockDrainQueue.mockResolvedValueOnce({
      synced: 0, failed: 1, rejectedPayments: [],
      syncHealthEvents: [{ name: 'sync_op_failed_corrupt', businessId: null, metadata: { operation: 'submit_sale', stage: 'decrypt' } }],
    });
    await useSyncStore.getState().sync();
    expect(mockTrackEvent).toHaveBeenCalledWith('sync_op_failed_corrupt', null, null, { operation: 'submit_sale', stage: 'decrypt' });
  });

  it('still returns the full result and updates pendingCount even when events are present', async () => {
    mockGetQueueCount.mockResolvedValueOnce(3);
    mockDrainQueue.mockResolvedValueOnce({
      synced: 1, failed: 1, rejectedPayments: [],
      syncHealthEvents: [{ name: 'sync_op_failed_permanent', businessId: 'biz-1', metadata: {} }],
    });
    const result = await useSyncStore.getState().sync();
    expect(result.synced).toBe(1);
    expect(useSyncStore.getState().pendingCount).toBe(3);
    expect(useSyncStore.getState().syncing).toBe(false);
  });
});
