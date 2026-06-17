// Cart state logic — pure operations, no network calls
// These tests guard against regressions in the POS cart before submit_sale fires.

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
  enqueue: jest.fn(),
  getQueueCount: jest.fn().mockResolvedValue(0),
  openDb: jest.fn(),
}));

jest.mock('@/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/lib/posthog', () => ({ posthog: null }));

import { useSalesStore } from '@/stores/sales';
import { supabase } from '@/lib/supabase';
import type { Product } from '@/src/types';

function makeProduct(id: string, price: number, bulkPrice?: number): Product {
  return {
    id,
    business_id: 'biz-1',
    name: `Produit ${id}`,
    sku: null,
    category: null,
    unit: 'pcs',
    cost_price: price * 0.6,
    sale_price: price,
    reorder_level: 0,
    stock_qty: 100,
    archived: false,
    supplier_id: null,
    purchase_date: null,
    bulk_price: bulkPrice ?? null,
    bulk_min_qty: bulkPrice ? 10 : null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    created_by: 'user-1',
    has_variants: false,
  };
}

beforeEach(() => {
  useSalesStore.setState({ cart: [], submitting: false, error: null, lastSubmitQueued: false });
  jest.clearAllMocks();
});

describe('addToCart', () => {
  it('creates a new cart line on first add', () => {
    useSalesStore.getState().addToCart(makeProduct('p1', 1000));
    const cart = useSalesStore.getState().cart;
    expect(cart).toHaveLength(1);
    expect(cart[0].qty).toBe(1);
    expect(cart[0].unit_price).toBe(1000);
  });

  it('increments qty when the same product is added again', () => {
    const p = makeProduct('p1', 1000);
    useSalesStore.getState().addToCart(p);
    useSalesStore.getState().addToCart(p);
    const cart = useSalesStore.getState().cart;
    expect(cart).toHaveLength(1);
    expect(cart[0].qty).toBe(2);
  });

  it('creates separate lines for bulk vs non-bulk of the same product', () => {
    const p = makeProduct('p1', 1000, 750);
    useSalesStore.getState().addToCart(p, false);
    useSalesStore.getState().addToCart(p, true);
    const cart = useSalesStore.getState().cart;
    expect(cart).toHaveLength(2);
    expect(cart.find(l => !l.is_bulk)?.unit_price).toBe(1000);
    expect(cart.find(l => l.is_bulk)?.unit_price).toBe(750);
  });

  it('uses bulk_price when bulk=true', () => {
    const p = makeProduct('p1', 1000, 750);
    useSalesStore.getState().addToCart(p, true);
    expect(useSalesStore.getState().cart[0].unit_price).toBe(750);
  });

  it('falls back to sale_price when product has no bulk_price', () => {
    const p = makeProduct('p1', 1000); // no bulkPrice
    useSalesStore.getState().addToCart(p, true);
    expect(useSalesStore.getState().cart[0].unit_price).toBe(1000);
  });
});

describe('setQty', () => {
  it('updates qty to the new value', () => {
    useSalesStore.getState().addToCart(makeProduct('p1', 1000));
    useSalesStore.getState().setQty('p1', 5);
    expect(useSalesStore.getState().cart[0].qty).toBe(5);
  });

  it('removes the item when qty is set to 0', () => {
    useSalesStore.getState().addToCart(makeProduct('p1', 1000));
    useSalesStore.getState().setQty('p1', 0);
    expect(useSalesStore.getState().cart).toHaveLength(0);
  });
});

describe('removeFromCart and clearCart', () => {
  it('removes only the specified product, leaves others intact', () => {
    useSalesStore.getState().addToCart(makeProduct('p1', 1000));
    useSalesStore.getState().addToCart(makeProduct('p2', 500));
    useSalesStore.getState().removeFromCart('p1');
    const cart = useSalesStore.getState().cart;
    expect(cart).toHaveLength(1);
    expect(cart[0].product.id).toBe('p2');
  });

  it('empties the cart completely on clearCart', () => {
    useSalesStore.getState().addToCart(makeProduct('p1', 1000));
    useSalesStore.getState().addToCart(makeProduct('p2', 500));
    useSalesStore.getState().clearCart();
    expect(useSalesStore.getState().cart).toHaveLength(0);
  });
});

describe('submitSale — total amount calculation', () => {
  it('sends the correct total for a multi-item cart to supabase', async () => {
    (supabase.rpc as jest.Mock).mockResolvedValueOnce({ error: null });

    // p1: 1 × 1000 = 1000
    // p2: added twice → qty 2 × 500 = 1000
    // total = 2000
    useSalesStore.getState().addToCart(makeProduct('p1', 1000));
    useSalesStore.getState().addToCart(makeProduct('p2', 500));
    useSalesStore.getState().addToCart(makeProduct('p2', 500));

    await useSalesStore.getState().submitSale('biz-1', 'user-1', { method: 'especes', amount: 2000 });

    expect(supabase.rpc).toHaveBeenCalledWith('submit_sale', expect.objectContaining({
      p_total_amount: 200000,
    }));
  });
});
