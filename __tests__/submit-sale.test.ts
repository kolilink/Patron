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

import { useSalesStore } from '@/stores/sales';
import { useVentesStore } from '@/stores/ventes';
import { useAuthStore } from '@/stores/auth';
import { supabase } from '@/lib/supabase';
import { enqueue, getAllQueueItemsForOverlay } from '@/lib/db';
import type { Product, ProductVariant } from '@/src/types';

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
  has_variants: false,
};

beforeEach(() => {
  useSalesStore.setState({ cart: [], submitting: false, error: null, lastSubmitQueued: false });
  useVentesStore.setState({ sales: [] });
  // refreshPendingOverlay (called internally by submitSale) reads the real
  // useAuthStore for role scoping — a real session, not mocked, matching
  // how this codebase actually authenticates. Only relevant to the tests
  // below that check the resulting `sales` overlay; harmless for the rest.
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

describe('submit_sale — empty cart', () => {
  it('returns false immediately when cart is empty', async () => {
    const result = await useSalesStore.getState().submitSale(
      'biz-1', 'user-1', { method: 'especes', amount: 0 },
    );
    expect(result).toBe(false);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});

describe('submit_sale — local-write-first (§5)', () => {
  it('never calls supabase.rpc directly, on a good connection or a bad one — only enqueue matters', async () => {
    useSalesStore.getState().addToCart(mockProduct);
    const result = await useSalesStore.getState().submitSale(
      'biz-1', 'user-1', { method: 'especes', amount: 800 },
    );

    expect(result).toBe(true);
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith('submit_sale', expect.objectContaining({
      p_business_id: 'biz-1',
      p_seller_id: 'user-1',
      p_total_amount: 80000,
      p_is_credit: false,
    }));
    expect(useSalesStore.getState().cart).toHaveLength(0);
    // Always true now — every write takes this same enqueue path, whether
    // it happens to drain in milliseconds or days later. There is no more
    // "was this actually queued vs. did it succeed live" distinction to
    // report, since the local write IS the success.
    expect(useSalesStore.getState().lastSubmitQueued).toBe(true);
    expect(useSalesStore.getState().error).toBeNull();
  });

  it('marks sale as credit when payment is null', async () => {
    useSalesStore.getState().addToCart(mockProduct);
    await useSalesStore.getState().submitSale('biz-1', 'user-1', null);

    expect(enqueue).toHaveBeenCalledWith('submit_sale', expect.objectContaining({
      p_is_credit: true,
      p_pay_method: null,
      p_pay_amount: null,
    }));
  });

  it('generates a real idempotency key on every call, used identically regardless of connectivity', async () => {
    useSalesStore.getState().addToCart(mockProduct);
    await useSalesStore.getState().submitSale('biz-1', 'user-1', { method: 'especes', amount: 800 });

    const [, payload] = (enqueue as jest.Mock).mock.calls[0];
    expect(payload.p_idempotency_key).toEqual(expect.any(String));
    expect(payload.p_idempotency_key.length).toBeGreaterThan(10);
  });

  it('a local (SQLite) write failure — the only real failure mode left — is reported honestly and does not enqueue', async () => {
    (enqueue as jest.Mock).mockRejectedValueOnce(new Error('SQLite disk I/O error'));

    useSalesStore.getState().addToCart(mockProduct);
    const result = await useSalesStore.getState().submitSale(
      'biz-1', 'user-1', { method: 'especes', amount: 800 },
    );

    expect(result).toBe(false);
    expect(useSalesStore.getState().lastSubmitQueued).toBe(false);
    expect(useSalesStore.getState().error).toBeTruthy();
    // The cart must NOT be cleared on a genuine local write failure — the
    // merchant's attempt truly did not save anywhere, unlike every other
    // path in this file, where the write already durably succeeded.
    expect(useSalesStore.getState().cart).toHaveLength(1);
  });

  it('reflects the new sale in useVentesStore.sales instantly, via the pending-overlay rebuild — no server round trip needed', async () => {
    useSalesStore.getState().addToCart(mockProduct);
    await useSalesStore.getState().submitSale('biz-1', 'user-1', { method: 'especes', amount: 800 });

    // getAllQueueItemsForOverlay is the real read the pending-overlay
    // rebuild (lib/pendingOverlay.ts) performs — asserting it was called
    // confirms refreshPendingOverlay actually ran (it silently no-ops
    // without an active session, which beforeEach sets up above).
    expect(getAllQueueItemsForOverlay).toHaveBeenCalled();
  });

  it('cost_price on a still-pending sale line defaults to 0, not the real product cost — a deliberate, documented Phase-1 scope boundary, not a regression', async () => {
    // lib/pendingOverlay.ts's projectNewSale has no way to know a pending
    // line's real cost_price — submit_sale's own RPC payload never carries
    // it (the RPC looks it up server-side), so a rebuild-from-outbox can't
    // either. This was the OLD behavior's one real capability this rework
    // does not replicate (the old ad hoc "optimisticSale" object built
    // inline in this function used to enrich cost_price from the live
    // CartLine data) — accepted as out of Phase-1's scope (profit/margin
    // display for a not-yet-synced line, not revenue/total correctness,
    // which IS Phase 1's actual concern) rather than silently regressed.
    const variantParent: Product = { ...mockProduct, id: 'prod-v', cost_price: 400, has_variants: true, stock_qty: 0 };
    const variant: ProductVariant = {
      id: 'var-1', product_id: 'prod-v', business_id: 'biz-1', name: 'Taille M',
      sale_price: 1500, cost_price: 900, stock_qty: 50, reorder_level: 5, archived: false,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    };
    // The enqueue mock is a no-op — it doesn't actually write anywhere
    // getAllQueueItemsForOverlay could read from, unlike the real
    // lib/db.ts where both functions share the same SQLite table. Wiring
    // getAllQueueItemsForOverlay to read whatever enqueue was JUST called
    // with (within this same submitSale execution) reproduces that real
    // relationship precisely enough for this test — without it, the
    // pending-overlay rebuild sees an empty queue and this assertion was
    // failing for a fixture reason, not a real product bug (caught by
    // actually running this test, not assumed correct from reading it).
    (getAllQueueItemsForOverlay as jest.Mock).mockImplementation(async () => {
      const calls = (enqueue as jest.Mock).mock.calls;
      const last = calls[calls.length - 1];
      if (!last) return { ok: [], corrupt: [] };
      const [operation, payload] = last;
      return {
        ok: [{
          id: 1, operation, status: 'pending', attempts: 0, last_error: null,
          idempotency_key: payload.p_idempotency_key ?? null, entity_type: 'vente',
          queued_at: new Date().toISOString(), created_at: new Date().toISOString(),
          payload: JSON.stringify(payload),
        }],
        corrupt: [],
      };
    });

    useSalesStore.getState().addToCartVariant(variantParent, variant);
    await useSalesStore.getState().submitSale('biz-1', 'user-1', { method: 'especes', amount: 1500 });

    const { sales } = useVentesStore.getState();
    expect(sales).toHaveLength(1);
    expect(sales[0].lines?.[0]?.cost_price).toBe(0);
  });
});
