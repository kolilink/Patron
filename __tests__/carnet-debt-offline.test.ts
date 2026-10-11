// submit_carnet_debt — rewritten for the offline-first rewrite's §5
// local-write-first model. Same core property submit-sale.test.ts now
// guards: submitCarnetDebt() never calls supabase.rpc directly under any
// connectivity state — only lib/sync.ts's executeOp does, at drain time.

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: jest.fn(),
    from: jest.fn(),
    auth: {
      onAuthStateChange: jest.fn(() => ({
        data: { subscription: { unsubscribe: jest.fn() } },
      })),
    },
  },
}));

jest.mock('@/lib/db', () => ({
  enqueue:       jest.fn().mockResolvedValue(undefined),
  getQueueCount: jest.fn().mockResolvedValue(1),
  openDb:        jest.fn(),
}));

// This file tests submitCarnetDebt's own logic, not the pending-overlay
// mechanism (covered separately by __tests__/pending-overlay.test.ts and
// __tests__/ventes-pending-overlay.test.ts) or drain internals (covered by
// __tests__/offline-drain.test.ts and __tests__/sync-store.test.ts) — both
// mocked to simple no-ops so this file stays scoped to what it's actually
// about.
const mockRefreshPendingOverlay = jest.fn().mockResolvedValue(undefined);
jest.mock('@/stores/ventes', () => ({
  useVentesStore: { getState: () => ({ refreshPendingOverlay: mockRefreshPendingOverlay }) },
}));

let mockPendingCount = 0;
const mockKick = jest.fn();
jest.mock('@/stores/sync', () => ({
  useSyncStore: {
    getState: () => ({ kick: mockKick, pendingCount: mockPendingCount }),
    setState: (patch: { pendingCount?: number }) => {
      if (patch.pendingCount !== undefined) mockPendingCount = patch.pendingCount;
    },
  },
}));

jest.mock('@/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/lib/posthog', () => ({ posthog: null }));

import { useSalesStore } from '@/stores/sales';
import { useSyncStore } from '@/stores/sync';
import { supabase } from '@/lib/supabase';
import { enqueue } from '@/lib/db';

beforeEach(() => {
  useSalesStore.setState({ cart: [], submitting: false, error: null, lastSubmitQueued: false, lastCarnetDebtQueued: false });
  mockPendingCount = 0;
  jest.clearAllMocks();
});

describe('submit_carnet_debt — local-write-first (§5)', () => {
  it('never calls supabase.rpc directly — only enqueue, with a real idempotency key', async () => {
    const result = await useSalesStore.getState().submitCarnetDebt('biz-1', 'user-1', 'Mamadou', 500000, null);

    expect(result.ok).toBe(true);
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith('submit_carnet_debt', expect.objectContaining({
      p_business_id:     'biz-1',
      p_seller_id:       'user-1',
      p_customer_name:   'Mamadou',
      p_amount:          500000,
      p_client_id:       null,
      p_idempotency_key: expect.any(String),
    }));
    // Always true now — see submit-sale.test.ts's identical note. There is
    // no more "did this succeed live vs. get queued" distinction to report.
    expect(useSalesStore.getState().lastCarnetDebtQueued).toBe(true);
  });

  it('kicks the drainer after a successful local write — the fast path for a good connection', async () => {
    await useSalesStore.getState().submitCarnetDebt('biz-1', 'user-1', 'Aïssatou', 250000, null);
    expect(mockKick).toHaveBeenCalled();
  });

  it('updates pendingCount from the real queue count after enqueueing', async () => {
    await useSalesStore.getState().submitCarnetDebt('biz-1', 'user-1', 'Aïssatou', 250000, null);
    expect(useSyncStore.getState().pendingCount).toBe(1); // getQueueCount mocked to resolve 1
  });

  it('generates a real, non-empty idempotency key on every call — this is what makes the drain-time RPC dedup possible (migration_v186)', async () => {
    await useSalesStore.getState().submitCarnetDebt('biz-1', 'user-1', 'Ousmane', 100000, null);
    const key = (enqueue as jest.Mock).mock.calls[0][1].p_idempotency_key;
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThan(10);
  });

  it('a genuine local (SQLite) write failure — the only real failure mode left — is reported honestly, not silently swallowed', async () => {
    (enqueue as jest.Mock).mockRejectedValueOnce(new Error('SQLite disk I/O error'));

    const result = await useSalesStore.getState().submitCarnetDebt('biz-1', 'user-1', 'Client', 100000, null);

    expect(result.ok).toBe(false);
    expect(useSalesStore.getState().lastCarnetDebtQueued).toBe(false);
    expect(mockKick).not.toHaveBeenCalled(); // nothing to sync — the write never happened
  });

  it('a failure in refreshPendingOverlay (after the write already succeeded) never flips the reported result to false', async () => {
    // The write itself (enqueue) is the money-critical part and already
    // durably succeeded by the time refreshPendingOverlay runs — a
    // failure reflecting it in the UI must never be reported back to the
    // merchant as "your debt wasn't recorded," which would be a lie.
    mockRefreshPendingOverlay.mockRejectedValueOnce(new Error('cache read failed'));
    const result = await useSalesStore.getState().submitCarnetDebt('biz-1', 'user-1', 'Client', 100000, null);
    expect(result.ok).toBe(true);
    expect(enqueue).toHaveBeenCalled();
  });
});
