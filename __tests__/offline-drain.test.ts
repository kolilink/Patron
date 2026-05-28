// drainQueue behavior — the engine that replays queued sales when back online.
// These tests guard the retry logic: what stops, what continues, what gets deleted.

const mockGetPendingOps = jest.fn();
const mockDeleteQueueItem = jest.fn();
const mockMarkAttemptFailed = jest.fn();

jest.mock('@/lib/db', () => ({
  getPendingOps: mockGetPendingOps,
  deleteQueueItem: mockDeleteQueueItem,
  markAttemptFailed: mockMarkAttemptFailed,
  getQueueCount: jest.fn().mockResolvedValue(0),
}));

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: jest.fn(),
    from: jest.fn(() => ({ insert: jest.fn().mockResolvedValue({ error: null }) })),
    auth: {
      onAuthStateChange: jest.fn(() => ({
        data: { subscription: { unsubscribe: jest.fn() } },
      })),
    },
  },
}));

import { drainQueue } from '@/lib/sync';
import { supabase } from '@/lib/supabase';

function makeSaleOp(id: number) {
  return {
    id,
    operation: 'submit_sale',
    payload: JSON.stringify({
      p_business_id: 'biz-1',
      p_seller_id: 'user-1',
      p_total_amount: 1000,
      p_cart: [],
    }),
    created_at: '2026-01-01T00:00:00Z',
    attempts: 0,
    last_error: null,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDeleteQueueItem.mockResolvedValue(undefined);
  mockMarkAttemptFailed.mockResolvedValue(undefined);
});

describe('drainQueue', () => {
  it('returns {synced: 0, failed: 0} when the queue is empty', async () => {
    mockGetPendingOps.mockResolvedValueOnce([]);
    const result = await drainQueue();
    expect(result).toEqual({ synced: 0, failed: 0 });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('syncs a pending item and deletes it from the queue', async () => {
    mockGetPendingOps.mockResolvedValueOnce([makeSaleOp(1)]);
    (supabase.rpc as jest.Mock).mockResolvedValueOnce({ error: null });

    const result = await drainQueue();

    expect(result).toEqual({ synced: 1, failed: 0 });
    expect(supabase.rpc).toHaveBeenCalledWith('submit_sale', expect.objectContaining({
      p_business_id: 'biz-1',
    }));
    expect(mockDeleteQueueItem).toHaveBeenCalledWith(1);
  });

  it('stops immediately on network error — does not attempt remaining items', async () => {
    mockGetPendingOps.mockResolvedValueOnce([makeSaleOp(1), makeSaleOp(2)]);
    (supabase.rpc as jest.Mock).mockRejectedValueOnce(new Error('Failed to fetch'));

    const result = await drainQueue();

    expect(result.failed).toBe(1);
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(mockDeleteQueueItem).not.toHaveBeenCalled();
    expect(mockMarkAttemptFailed).not.toHaveBeenCalled();
  });

  it('marks attempt failed on server error and continues to next item', async () => {
    mockGetPendingOps.mockResolvedValueOnce([makeSaleOp(1), makeSaleOp(2)]);
    (supabase.rpc as jest.Mock)
      .mockResolvedValueOnce({ error: { message: 'invalid input syntax' } }) // item 1: server error
      .mockResolvedValueOnce({ error: null }); // item 2: success

    const result = await drainQueue();

    expect(result).toEqual({ synced: 1, failed: 1 });
    expect(mockMarkAttemptFailed).toHaveBeenCalledWith(1, expect.any(String));
    expect(mockDeleteQueueItem).toHaveBeenCalledWith(2);
  });
});
