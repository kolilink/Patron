// Critical path 1: submit_sale online
// Critical path 2: offline queue (enqueue on network failure)

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
}));

import { useSalesStore } from '@/stores/sales';
import { supabase } from '@/lib/supabase';
import { enqueue } from '@/lib/db';
import type { Product } from '@/src/types';

const mockProduct: Product = {
  id: 'prod-1',
  business_id: 'biz-1',
  name: 'Riz local',
  sku: null,
  category: null,
  unit: 'kg',
  cost_price: 500,
  sale_price: 800,
  reorder_level: 0,
  stock_qty: 100,
  archived: false,
  supplier_id: null,
  purchase_date: null,
  bulk_price: null,
  bulk_min_qty: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  created_by: 'user-1',
};

beforeEach(() => {
  useSalesStore.setState({ cart: [], submitting: false, error: null, lastSubmitQueued: false });
  jest.clearAllMocks();
});

describe('submit_sale — empty cart', () => {
  it('returns false immediately when cart is empty', async () => {
    const result = await useSalesStore.getState().submitSale(
      'biz-1', 'user-1', { method: 'especes', amount: 0 },
    );
    expect(result).toBe(false);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});

describe('submit_sale — online success', () => {
  it('calls supabase.rpc, clears cart, and returns true', async () => {
    (supabase.rpc as jest.Mock).mockResolvedValueOnce({ error: null });

    useSalesStore.getState().addToCart(mockProduct);
    expect(useSalesStore.getState().cart).toHaveLength(1);

    const result = await useSalesStore.getState().submitSale(
      'biz-1', 'user-1', { method: 'especes', amount: 800 },
    );

    expect(result).toBe(true);
    expect(supabase.rpc).toHaveBeenCalledWith('submit_sale', expect.objectContaining({
      p_business_id: 'biz-1',
      p_seller_id: 'user-1',
      p_total_amount: 80000,
      p_is_credit: false,
    }));
    expect(useSalesStore.getState().cart).toHaveLength(0);
    expect(useSalesStore.getState().lastSubmitQueued).toBe(false);
    expect(useSalesStore.getState().error).toBeNull();
  });

  it('marks sale as credit when payment is null', async () => {
    (supabase.rpc as jest.Mock).mockResolvedValueOnce({ error: null });

    useSalesStore.getState().addToCart(mockProduct);
    await useSalesStore.getState().submitSale('biz-1', 'user-1', null);

    expect(supabase.rpc).toHaveBeenCalledWith('submit_sale', expect.objectContaining({
      p_is_credit: true,
      p_pay_method: null,
      p_pay_amount: null,
    }));
  });
});

describe('submit_sale — offline queue', () => {
  it('enqueues when supabase throws a network error', async () => {
    (supabase.rpc as jest.Mock).mockRejectedValueOnce(new Error('Failed to fetch'));

    useSalesStore.getState().addToCart(mockProduct);
    const result = await useSalesStore.getState().submitSale(
      'biz-1', 'user-1', { method: 'especes', amount: 800 },
    );

    expect(result).toBe(true);
    expect(enqueue).toHaveBeenCalledWith('submit_sale', expect.objectContaining({
      p_business_id: 'biz-1',
      p_total_amount: 80000,
    }));
    expect(useSalesStore.getState().cart).toHaveLength(0);
    expect(useSalesStore.getState().lastSubmitQueued).toBe(true);
  });

  it('does NOT enqueue when supabase returns a non-network error', async () => {
    (supabase.rpc as jest.Mock).mockResolvedValueOnce({
      error: { message: 'permission denied for table sale_orders', code: '42501' },
    });

    useSalesStore.getState().addToCart(mockProduct);
    const result = await useSalesStore.getState().submitSale(
      'biz-1', 'user-1', { method: 'especes', amount: 800 },
    );

    expect(result).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
    expect(useSalesStore.getState().lastSubmitQueued).toBe(false);
    expect(useSalesStore.getState().error).toBeTruthy();
  });
});
