// recordPayment guard: the server (record_payment RPC) is the source of truth
// for "how much is still owed" — these tests guard against the race condition
// where a stale on-device balance would otherwise let a debt be paid twice.

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
  enqueue:           jest.fn().mockResolvedValue(undefined),
  getQueueCount:     jest.fn().mockResolvedValue(1),
  openDb:            jest.fn(),
  saveVentesCache:   jest.fn().mockResolvedValue(undefined),
  getVentesCache:    jest.fn().mockResolvedValue(null),
  getCacheTimestamp: jest.fn().mockResolvedValue(null),
}));

jest.mock('@/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/lib/posthog', () => ({ posthog: null }));

import { useVentesStore, type Vente } from '@/stores/ventes';
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
  total_amount: 1650000,
  discount_amount: 0,
  paid_at: null,
  sale_date: '2026-06-20',
  created_at: '2026-06-20T00:00:00Z',
  cancelled_at: null,
  cancellation_reason: null,
  profit: null,
  amount_paid: 0,
};

beforeEach(() => {
  useVentesStore.setState({ sales: [creditSale], saving: false, error: null });
  jest.clearAllMocks();
});

describe('recordPayment — online', () => {
  it('on success, applies the optimistic update and returns fullyPaid from the server', async () => {
    (supabase.rpc as jest.Mock).mockResolvedValueOnce({ data: true, error: null });

    const result = await useVentesStore.getState().recordPayment('sale-1', 16500, 'especes', '2026-06-30');

    expect(result).toEqual({ ok: true, fullyPaid: true });
    expect(supabase.rpc).toHaveBeenCalledWith('record_payment', {
      p_sale_id: 'sale-1',
      p_business_id: 'biz-1',
      p_amount: 1650000,
      p_method: 'especes',
      p_date: '2026-06-30',
    });
  });

  it('rejects when the server says the debt is already settled — does not apply the optimistic update', async () => {
    (supabase.rpc as jest.Mock).mockResolvedValueOnce({
      data: null,
      error: { message: 'Le montant dépasse le solde restant dû' },
    });

    const result = await useVentesStore.getState().recordPayment('sale-1', 16500, 'especes', '2026-06-30');

    expect(result).toEqual({ ok: false, fullyPaid: false });
    expect(useVentesStore.getState().sales[0].amount_paid).toBe(0);
    expect(useVentesStore.getState().sales[0].status).toBe('credit');
  });
});

describe('recordPayment — offline queue', () => {
  it('enqueues a record_payment RPC call (not precomputed rows) on network error', async () => {
    (supabase.rpc as jest.Mock).mockRejectedValueOnce(new Error('Network request failed'));

    const result = await useVentesStore.getState().recordPayment('sale-1', 16500, 'especes', '2026-06-30');

    expect(result.ok).toBe(true);
    expect(enqueue).toHaveBeenCalledWith('record_payment', {
      p_sale_id: 'sale-1',
      p_business_id: 'biz-1',
      p_amount: 1650000,
      p_method: 'especes',
      p_date: '2026-06-30',
    });
  });
});
