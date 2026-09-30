// record_payment — online-first (live RPC) with an offline enqueue fallback,
// restored from the pre-rewrite shape so recordPayment() returns the real
// server-side payment_id for the SaveConfirmation "Annuler" undo
// (migration_v205's jsonb contract, PR #41). Only lib/sync.ts's executeOp
// calls record_payment at drain time when the original live call failed with
// a network error and the payment was enqueued instead.

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
  // Default: the live RPC succeeds and returns the jsonb contract.
  (supabase.rpc as jest.Mock).mockResolvedValue({
    data: { fully_paid: true, payment_id: 'pay-server-1' },
    error: null,
  });
});

describe('record_payment — online-first with offline fallback (§5)', () => {
  it('calls supabase.rpc directly and returns the real server-side payment_id', async () => {
    const result = await useVentesStore.getState().recordPayment('sale-1', 16500, 'especes', '2026-06-30');

    expect(result).toEqual({ ok: true, fullyPaid: true, paymentId: 'pay-server-1' });
    expect(supabase.rpc).toHaveBeenCalledWith('record_payment', {
      p_sale_id: 'sale-1',
      p_business_id: 'biz-1',
      p_amount: 1650000,
      p_method: 'especes',
      p_date: '2026-06-30',
      p_idempotency_key: expect.any(String),
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('generates a real, non-empty idempotency key on every call', async () => {
    await useVentesStore.getState().recordPayment('sale-1', 16500, 'especes', '2026-06-30');
    const key = (supabase.rpc as jest.Mock).mock.calls[0][1].p_idempotency_key;
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThan(10);
  });

  it('reports fullyPaid from the RPC response (the server-side truth)', async () => {
    (supabase.rpc as jest.Mock).mockResolvedValueOnce({
      data: { fully_paid: false, payment_id: 'pay-server-1' },
      error: null,
    });
    const result = await useVentesStore.getState().recordPayment('sale-1', 5000, 'especes', '2026-06-30');
    expect(result.fullyPaid).toBe(false); // server says it still owes
    expect(result.paymentId).toBe('pay-server-1');
  });

  it('falls back to enqueue + kick on a network error, with no paymentId until the queue drains', async () => {
    (supabase.rpc as jest.Mock).mockRejectedValueOnce(new Error('fetch failed'));

    const result = await useVentesStore.getState().recordPayment('sale-1', 16500, 'especes', '2026-06-30');

    expect(result.ok).toBe(true);
    expect(result.fullyPaid).toBe(true); // optimistic on-device balance
    expect(result.paymentId).toBeUndefined(); // no server row yet
    expect(enqueue).toHaveBeenCalledWith('record_payment', expect.objectContaining({ p_sale_id: 'sale-1' }));
    expect(mockKick).toHaveBeenCalled();
  });

  it('updates pendingCount from the real queue count after an offline-fallback enqueue', async () => {
    (supabase.rpc as jest.Mock).mockRejectedValueOnce(new Error('fetch failed'));

    await useVentesStore.getState().recordPayment('sale-1', 16500, 'especes', '2026-06-30');

    expect(useSyncStore.getState().pendingCount).toBe(1); // getQueueCount mocked to resolve 1
  });

  it('a genuine local (SQLite) write failure in the offline fallback is reported honestly, not silently swallowed', async () => {
    (supabase.rpc as jest.Mock).mockRejectedValueOnce(new Error('fetch failed'));
    (enqueue as jest.Mock).mockRejectedValueOnce(new Error('SQLite disk I/O error'));

    const result = await useVentesStore.getState().recordPayment('sale-1', 16500, 'especes', '2026-06-30');

    expect(result).toEqual({ ok: false, fullyPaid: false });
    expect(mockKick).not.toHaveBeenCalled(); // nothing to sync — the write never happened
  });

  it('a non-network RPC error surfaces as ok:false without enqueueing', async () => {
    (supabase.rpc as jest.Mock).mockRejectedValueOnce(new Error('Le montant dépasse le solde restant dû'));

    const result = await useVentesStore.getState().recordPayment('sale-1', 99999, 'especes', '2026-06-30');

    expect(result).toEqual({ ok: false, fullyPaid: false });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('a failure in refreshPendingOverlay (after the write already succeeded) never flips the reported result to false', async () => {
    mockRefreshPendingOverlay.mockRejectedValueOnce(new Error('cache read failed'));
    const result = await useVentesStore.getState().recordPayment('sale-1', 16500, 'especes', '2026-06-30');
    expect(result.ok).toBe(true);
    expect(result.paymentId).toBe('pay-server-1');
  });

  it('returns ok:false without calling rpc or enqueue when the sale is not found locally', async () => {
    const result = await useVentesStore.getState().recordPayment('missing-sale', 16500, 'especes', '2026-06-30');
    expect(result).toEqual({ ok: false, fullyPaid: false });
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
