// submit_carnet_debt — offline queue + idempotency (mocked supabase.rpc).
// Mirrors submit-sale.test.ts's "offline queue" block: this is the exact
// same class of fix (see migration_v122.sql's submit_sale guard) applied
// to the Crédit rapide / Quick Capture flow, which previously had no
// offline safety net at all — a bad-connection moment just hung and lost
// the entry with nothing queued to retry.

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

jest.mock('@/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/lib/posthog', () => ({ posthog: null }));

import { useSalesStore } from '@/stores/sales';
import { useSyncStore } from '@/stores/sync';
import { supabase } from '@/lib/supabase';
import { enqueue } from '@/lib/db';

beforeEach(() => {
  useSalesStore.setState({ cart: [], submitting: false, error: null, lastSubmitQueued: false, lastCarnetDebtQueued: false });
  useSyncStore.setState({ pendingCount: 0 });
  jest.clearAllMocks();
});

describe('submit_carnet_debt — online success', () => {
  it('calls supabase.rpc with a real idempotency key, returns true, and lastCarnetDebtQueued stays false', async () => {
    (supabase.rpc as jest.Mock).mockResolvedValueOnce({ error: null });

    const result = await useSalesStore.getState().submitCarnetDebt('biz-1', 'user-1', 'Mamadou', 500000, null);

    expect(result).toBe(true);
    expect(supabase.rpc).toHaveBeenCalledWith('submit_carnet_debt', expect.objectContaining({
      p_business_id:     'biz-1',
      p_seller_id:       'user-1',
      p_customer_name:   'Mamadou',
      p_amount:          500000,
      p_client_id:       null,
      p_idempotency_key: expect.any(String),
    }));
    expect(useSalesStore.getState().lastCarnetDebtQueued).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('submit_carnet_debt — offline queue', () => {
  it('enqueues when supabase throws a network error, returns true, and flips lastCarnetDebtQueued', async () => {
    (supabase.rpc as jest.Mock).mockRejectedValueOnce(new Error('Failed to fetch'));

    const result = await useSalesStore.getState().submitCarnetDebt('biz-1', 'user-1', 'Aïssatou', 250000, null);

    expect(result).toBe(true);
    expect(enqueue).toHaveBeenCalledWith('submit_carnet_debt', expect.objectContaining({
      p_business_id:   'biz-1',
      p_customer_name: 'Aïssatou',
      p_amount:        250000,
    }));
    expect(useSalesStore.getState().lastCarnetDebtQueued).toBe(true);
    expect(useSyncStore.getState().pendingCount).toBe(1);
  });

  it('reuses the exact same idempotency key on the failed live attempt and the queued payload', async () => {
    // The whole point of migration_v186.sql's dedup guard: if the live RPC
    // call actually reached the server and committed before the client saw
    // the network error, the later queued replay must carry the SAME key —
    // two different keys here would silently double-record the debt.
    (supabase.rpc as jest.Mock).mockRejectedValueOnce(new Error('Failed to fetch'));

    await useSalesStore.getState().submitCarnetDebt('biz-1', 'user-1', 'Ousmane', 100000, null);

    const rpcKey = (supabase.rpc as jest.Mock).mock.calls[0][1].p_idempotency_key;
    const queuedKey = (enqueue as jest.Mock).mock.calls[0][1].p_idempotency_key;
    expect(rpcKey).toBeTruthy();
    expect(queuedKey).toBe(rpcKey);
  });

  it('does NOT enqueue when supabase returns a non-network error', async () => {
    (supabase.rpc as jest.Mock).mockResolvedValueOnce({
      error: { message: 'Accès refusé', code: '42501' },
    });

    const result = await useSalesStore.getState().submitCarnetDebt('biz-1', 'user-1', 'Client', 100000, null);

    expect(result).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
    expect(useSalesStore.getState().lastCarnetDebtQueued).toBe(false);
  });
});
