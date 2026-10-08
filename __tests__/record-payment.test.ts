// record_payment — local-write-first: validate -> enqueue -> reflect -> kick ->
// return. No supabase call precedes the durable write (network-kill proof);
// the only caller of the RPC is lib/sync.ts's executeOp at drain time.

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
  enqueue: jest.fn().mockResolvedValue(undefined),
  getQueueCount: jest.fn().mockResolvedValue(1),
  openDb: jest.fn(),
  saveVentesCache: jest.fn().mockResolvedValue(undefined),
  getVentesCache: jest.fn().mockResolvedValue(null),
  getCacheTimestamp: jest.fn().mockResolvedValue(null),
}));

// This file tests recordPayment's own logic, not the pending-overlay
// mechanism itself (covered by ventes-pending-overlay.test.ts) or drain
// internals (covered by offline-drain.test.ts/sync-store.test.ts) — both
// mocked to simple no-ops so this file stays scoped to what it's about.
const mockRefreshPendingOverlay = jest.fn().mockResolvedValue(undefined);

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
jest.mock('@/src/utils/notifications', () => ({ notifyEvent: jest.fn() }));
jest.mock('@/stores/auth', () => ({
  useAuthStore: { getState: () => ({ session: { activeBusiness: { currency: 'GNF' } } }) },
}));

import { useVentesStore, type Vente } from '@/stores/ventes';
import { useSyncStore } from '@/stores/sync';
import { supabase } from '@/lib/supabase';
import { enqueue } from '@/lib/db';

const creditSale: Vente = {
  id: 'sale-1',
  business_id: 'biz-1',
  customer_name: 'Aïssatou',
  client_id: null,
  seller_id: 'user-1',
  seller_name: 'Vendeur',
  status: 'credit',
  is_credit: true,
  total_amount: 16500,
  discount_amount: 0,
  paid_at: null,
  sale_date: '2026-06-20',
  created_at: '2026-06-20T00:00:00Z',
  cancelled_at: null,
  cancellation_reason: null,
  edit_count: 0,
  last_edited_at: null,
  profit: null,
  amount_paid: 0,
};

beforeEach(() => {
  useVentesStore.setState({ sales: [creditSale], saving: false, error: null, refreshPendingOverlay: mockRefreshPendingOverlay as never });
  mockPendingCount = 0;
  jest.clearAllMocks();
});

describe('record_payment — local-write-first', () => {
  it('enqueues and returns with NO supabase call at all (network-kill)', async () => {
    (supabase.rpc as jest.Mock).mockRejectedValue(new Error('Network request failed'));
    const result = await useVentesStore.getState().recordPayment('sale-1', 16500, 'especes', '2026-06-30');

    expect(result).toEqual({ ok: true, fullyPaid: true });   // optimistic on-device balance, no paymentId yet
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith('record_payment', {
      p_sale_id: 'sale-1',
      p_business_id: 'biz-1',
      p_amount: 1650000,
      p_method: 'especes',
      p_date: '2026-06-30',
      p_idempotency_key: expect.any(String),
    });
    expect(mockKick).toHaveBeenCalled();
  });

  it('reflects locally right away (overlay rebuilt after the durable write)', async () => {
    await useVentesStore.getState().recordPayment('sale-1', 5000, 'especes', '2026-06-30');
    expect(mockRefreshPendingOverlay).toHaveBeenCalled();
    expect(useVentesStore.getState().saving).toBe(false);
  });

  it('generates a real, non-empty idempotency key on every call', async () => {
    await useVentesStore.getState().recordPayment('sale-1', 16500, 'especes', '2026-06-30');
    const key = (enqueue as jest.Mock).mock.calls[0][1].p_idempotency_key;
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThan(10);
  });

  it('reports a partial payment as not fully paid from the on-device balance', async () => {
    const result = await useVentesStore.getState().recordPayment('sale-1', 5000, 'especes', '2026-06-30');
    expect(result.fullyPaid).toBe(false);
    expect(result.paymentId).toBeUndefined();
  });

  it('updates pendingCount from the real queue count after the enqueue', async () => {
    await useVentesStore.getState().recordPayment('sale-1', 16500, 'especes', '2026-06-30');
    expect(useSyncStore.getState().pendingCount).toBe(1); // getQueueCount mocked to resolve 1
  });

  it('a genuine local (SQLite) write failure is reported honestly, nothing kicked', async () => {
    (enqueue as jest.Mock).mockRejectedValueOnce(new Error('SQLite disk I/O error'));
    const result = await useVentesStore.getState().recordPayment('sale-1', 16500, 'especes', '2026-06-30');
    expect(result.ok).toBe(false);
    expect(mockKick).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('a failure in refreshPendingOverlay (after the write already succeeded) never flips the reported result to false', async () => {
    mockRefreshPendingOverlay.mockRejectedValueOnce(new Error('cache read failed'));
    const result = await useVentesStore.getState().recordPayment('sale-1', 16500, 'especes', '2026-06-30');
    expect(result.ok).toBe(true);
  });

  it('returns ok:false without enqueueing when the sale is not found locally', async () => {
    const result = await useVentesStore.getState().recordPayment('missing-sale', 16500, 'especes', '2026-06-30');
    expect(result).toEqual({ ok: false, fullyPaid: false });
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
