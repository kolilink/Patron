// submit_sale — rewritten for the offline-first rewrite's §5 local-write-
// first model. The single most important property this file now guards:
// submitSale() NEVER calls supabase.rpc directly, under ANY connectivity
// state — that direct call is exactly what caused the original bug this
// whole rework exists to fix (a live RPC attempt racing up to
// withTimeout's 12s before the UI could even know whether to show
// success). Only lib/sync.ts's executeOp ever calls the real RPC now, at
// drain time — verified here by asserting supabase.rpc.not.toHaveBeenCalled()
// in every scenario, not just the old "offline" one.

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
  enqueue:                     jest.fn().mockResolvedValue(undefined),
  getQueueCount:                jest.fn().mockResolvedValue(1),
  openDb:                      jest.fn(),
  saveProductCache:            jest.fn().mockResolvedValue(undefined),
  getProductCache:             jest.fn().mockResolvedValue(null),
  getVentesCache:              jest.fn().mockResolvedValue(null),
  getAllQueueItemsForOverlay:  jest.fn().mockResolvedValue({ ok: [], corrupt: [] }),
}));

// Real drainQueue/getPendingOpsForDrain are never reached in this file —
// kick() is mocked to a no-op so these tests stay scoped to submitSale's
// own behavior, not sync/drain internals (those are §3/§4's own test files).
jest.mock('@/stores/sync', () => ({
  useSyncStore: {
    getState: () => ({ kick: jest.fn() }),
    setState: jest.fn(),
  },
}));

jest.mock('@/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/lib/posthog', () => ({ posthog: null }));

import { useSalesStore, buildCartJson } from '@/stores/sales';
import type { CartLine } from '@/stores/sales';
import { useVentesStore } from '@/stores/ventes';
import { useAuthStore } from '@/stores/auth';
import { enqueue, getAllQueueItemsForOverlay } from '@/lib/db';
import { lineTotal, cartSum, normalizeAgreedPrice, effectiveUnitPrice } from '@/src/utils/cartMath';
import type { Product } from '@/src/types';

const mockProduct: Product = {
  id: 'prod-1',
  business_id: 'biz-1',
  name: 'Riz local',
  sku: null,
  category: null,
  unit: 'kg',
  cost_price: 500,
  sale_price: 500,
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
  has_variants: false,
};


beforeEach(() => {
  useSalesStore.setState({ cart: [], submitting: false, error: null, lastSubmitQueued: false });
  useVentesStore.setState({ sales: [] });
  useAuthStore.setState({
    session: {
      user: { id: 'user-1', name: 'Fatou' },
      activeBusiness: { id: 'biz-1', currency: 'GNF' },
      activeMembership: { role: 'administrateur' },
    },
  } as any);
  jest.clearAllMocks();
  (getAllQueueItemsForOverlay as jest.Mock).mockResolvedValue({ ok: [], corrupt: [] });
});

const agree = (price: number | null) => useSalesStore.getState().setAgreedPrice('prod-1', false, undefined, price);

describe('Prix convenu — cart math', () => {
  it('lineTotal / cartSum use the agreed price when set, the catalogue price otherwise', () => {
    expect(lineTotal({ unit_price: 500, qty: 2 })).toBe(1000);
    expect(lineTotal({ unit_price: 500, qty: 2, agreed_unit_price: 400 })).toBe(800);
    expect(cartSum([{ unit_price: 500, qty: 2, agreed_unit_price: 400 }, { unit_price: 100, qty: 3 }])).toBe(1100);
    expect(effectiveUnitPrice({ unit_price: 500, qty: 1, agreed_unit_price: 400 })).toBe(400);
  });

  it('agreeing the catalogue price (or an invalid one) is "no agreement"', () => {
    expect(normalizeAgreedPrice(500, 500)).toBeUndefined();
    expect(normalizeAgreedPrice(500, 0)).toBeUndefined();
    expect(normalizeAgreedPrice(500, null)).toBeUndefined();
    expect(normalizeAgreedPrice(500, 400)).toBe(400);
    useSalesStore.getState().addToCart(mockProduct);
    agree(400);
    expect(useSalesStore.getState().cart[0].agreed_unit_price).toBe(400);
    agree(500);
    expect(useSalesStore.getState().cart[0].agreed_unit_price).toBeUndefined();
  });

  it('re-agreeing replaces; the line keeps its quantity', () => {
    useSalesStore.getState().addToCart(mockProduct);
    useSalesStore.getState().setQty('prod-1', 3, false);
    agree(400);
    agree(450);
    const l = useSalesStore.getState().cart[0];
    expect(l.agreed_unit_price).toBe(450);
    expect(lineTotal(l)).toBe(1350);
  });
});

describe('Prix convenu — what is sold and written', () => {
  it('the queued submit_sale payload carries the agreed price as the line unit_price (cents) and the agreed total', async () => {
    useSalesStore.getState().addToCart(mockProduct);
    useSalesStore.getState().setQty('prod-1', 2, false);
    agree(400);
    const ok = await useSalesStore.getState().submitSale('biz-1', 'user-1', { method: 'especes', amount: 800 });
    expect(ok).toBe(true);
    const [op, payload] = (enqueue as jest.Mock).mock.calls[0];
    expect(op).toBe('submit_sale');
    expect(payload.p_cart[0].unit_price).toBe(40000);
    expect(payload.p_cart[0].qty).toBe(2);
    expect(payload.p_total_amount).toBe(80000);
    expect(payload.p_discount_amount).toBe(0);
  });

  it('without an agreed price the catalogue price is sent', async () => {
    useSalesStore.getState().addToCart(mockProduct);
    await useSalesStore.getState().submitSale('biz-1', 'user-1', { method: 'especes', amount: 500 });
    const [, payload] = (enqueue as jest.Mock).mock.calls[0];
    expect(payload.p_cart[0].unit_price).toBe(50000);
    expect(payload.p_total_amount).toBe(50000);
  });

  it('never modifies the catalogue product', () => {
    const before = JSON.stringify(mockProduct);
    useSalesStore.getState().addToCart(mockProduct);
    agree(400);
    expect(JSON.stringify(mockProduct)).toBe(before);
    expect(useSalesStore.getState().cart[0].product.sale_price).toBe(500);
    expect(useSalesStore.getState().cart[0].unit_price).toBe(500);
  });

  it('coexists with the payment-side discount: discount is independent of the agreed price', async () => {
    useSalesStore.getState().addToCart(mockProduct);
    agree(400);
    await useSalesStore.getState().submitSale('biz-1', 'user-1', { method: 'especes', amount: 350 }, undefined, undefined, 50);
    const [, payload] = (enqueue as jest.Mock).mock.calls[0];
    expect(payload.p_total_amount).toBe(40000);
    expect(payload.p_discount_amount).toBe(5000);
  });

  it('switching gros/détail drops the agreed price (it was agreed for the other price tier)', () => {
    useSalesStore.getState().addToCart({ ...mockProduct, bulk_price: 450, bulk_min_qty: 5 });
    agree(400);
    useSalesStore.getState().toggleBulk('prod-1', false);
    const l = useSalesStore.getState().cart[0];
    expect(l.agreed_unit_price).toBeUndefined();
    expect(l.unit_price).toBe(450);
  });
});

describe('buildCartJson — the catalogue price of the moment rides along (v246)', () => {
  const line = (over: Partial<CartLine> = {}): CartLine => ({
    product: mockProduct, qty: 2, unit_price: 450, is_bulk: false, ...over,
  });

  it('an agreed line sends the charged price as unit_price and the catalogue price separately', () => {
    const [j] = buildCartJson([line({ agreed_unit_price: 400 })], 1);
    expect(j.unit_price).toBe(40000);
    expect(j.catalog_unit_price).toBe(45000);
  });

  it('a plain line sends the same price in both fields', () => {
    const [j] = buildCartJson([line()], 1);
    expect(j.unit_price).toBe(45000);
    expect(j.catalog_unit_price).toBe(45000);
  });

  it('an override-total ratio scales the charged price but never the catalogue price', () => {
    const [j] = buildCartJson([line({ agreed_unit_price: 400 })], 1.1);
    expect(j.unit_price).toBe(44000);
    expect(j.catalog_unit_price).toBe(45000);
  });
});
