// Offline resilience — guards the 4 fixes shipped in the offline hardening pass.
//
// Fix 1: isNetworkError() recognises PostgrestError plain objects (not just Error instances).
//        Before the fix, String({ message: 'Network request failed' }) = '[object Object]'
//        — no keyword matched, so the sale was NOT queued and showed a raw error toast.
//
// Fix 2: products store falls back to SQLite cache when Supabase is unreachable.
//        After fallback, store.offline = true so the UI can show a stale-data indicator.
//
// Fix 3: cache is saved after every successful fetch and cleared when offline flag resets.

const mockSaveProductCache = jest.fn().mockResolvedValue(undefined);
const mockGetProductCache  = jest.fn();

jest.mock('@/lib/db', () => ({
  saveProductCache:  mockSaveProductCache,
  getProductCache:   mockGetProductCache,
  enqueue:           jest.fn(),
  getQueueCount:     jest.fn().mockResolvedValue(0),
  getCacheTimestamp: jest.fn().mockResolvedValue(null),
}));

jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: jest.fn(),
    auth: {
      onAuthStateChange: jest.fn(() => ({
        data: { subscription: { unsubscribe: jest.fn() } },
      })),
    },
  },
}));

jest.mock('@/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/lib/haptics',   () => ({ haptics: { success: jest.fn(), error: jest.fn(), tap: jest.fn() } }));

import { isNetworkError } from '@/lib/sync';
import { useProductStore } from '@/stores/products';
import { supabase } from '@/lib/supabase';

// ─── Product fixture ──────────────────────────────────────────────────────────
// Supabase stores values as BIGINT cents; the store divides by 100 on fetch.

const BUSINESS_ID = 'biz-offline-test';
const USER_ID     = 'user-1';

const BASE_FIELDS = {
  business_id: BUSINESS_ID, created_at: '', updated_at: '', created_by: '',
  sku: null, category: null, unit: 'unité', reorder_level: 0,
  supplier_id: null, purchase_date: null, bulk_min_qty: null,
};

const RAW_FROM_DB = {
  id: 'p1', name: 'Huile de palme', archived: false,
  sale_price: 500000, cost_price: 400000, bulk_price: null, stock_qty: 20,
  ...BASE_FIELDS,
};

const AFTER_TRANSFORM = {
  ...RAW_FROM_DB,
  sale_price: 5000, cost_price: 4000, bulk_price: null,
};

// A chain mock that resolves the final .order() call
function makeFromChain(result: { data: unknown; error: unknown }) {
  const chain = {
    select: jest.fn().mockReturnThis(),
    eq:     jest.fn().mockReturnThis(),
    order:  jest.fn().mockResolvedValueOnce(result),
  };
  return chain;
}

// ─── Fix 1: isNetworkError with PostgrestError plain objects ──────────────────

describe('isNetworkError — PostgrestError plain object shape (Fix 1)', () => {
  it('[regression guard] String({...}) is "[object Object]" — proves the old bug was real', () => {
    const postgrestError = { message: 'Network request failed' };
    expect(String(postgrestError)).toBe('[object Object]');
  });

  it('returns true for a PostgrestError with "Network request failed" in message', () => {
    const postgrestError = { message: 'TypeError: Network request failed', code: '', details: '', hint: '' };
    expect(isNetworkError(postgrestError)).toBe(true);
  });

  it('returns true for plain object with "fetch" in message', () => {
    expect(isNetworkError({ message: 'Failed to fetch' })).toBe(true);
  });

  it('returns true for plain object with "timeout" in message', () => {
    expect(isNetworkError({ message: 'request timeout' })).toBe(true);
  });

  it('returns true for plain object with "offline" in message', () => {
    expect(isNetworkError({ message: 'You are offline' })).toBe(true);
  });

  it('returns false for plain object with a server/auth error message', () => {
    expect(isNetworkError({ message: 'permission denied for table' })).toBe(false);
    expect(isNetworkError({ message: 'JWT expired' })).toBe(false);
    expect(isNetworkError({ message: 'duplicate key violates unique constraint' })).toBe(false);
  });

  it('returns false for plain object with no message property', () => {
    expect(isNetworkError({ code: '500', details: 'unknown' })).toBe(false);
  });

  it('still works correctly for native Error instances (regression)', () => {
    expect(isNetworkError(new Error('Network request failed'))).toBe(true);
    expect(isNetworkError(new Error('permission denied'))).toBe(false);
  });
});

// ─── Fix 2 + 3: products store offline cache behaviour ────────────────────────

describe('products store — offline cache fallback (Fix 2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useProductStore.getState().reset();
  });

  it('saves transformed products to cache after a successful fetch', async () => {
    (supabase.from as jest.Mock).mockReturnValueOnce(
      makeFromChain({ data: [RAW_FROM_DB], error: null }),
    );

    await useProductStore.getState().fetchProducts(BUSINESS_ID, USER_ID);

    expect(mockSaveProductCache).toHaveBeenCalledWith(
      BUSINESS_ID,
      expect.arrayContaining([
        expect.objectContaining({ id: 'p1', sale_price: 5000, cost_price: 4000 }),
      ]),
    );
    expect(useProductStore.getState().offline).toBe(false);
  });

  it('falls back to cache and sets offline:true when network fails', async () => {
    (supabase.from as jest.Mock).mockReturnValueOnce(
      makeFromChain({ data: null, error: { message: 'Network request failed' } }),
    );
    mockGetProductCache.mockResolvedValueOnce([AFTER_TRANSFORM]);

    await useProductStore.getState().fetchProducts(BUSINESS_ID, USER_ID);

    const state = useProductStore.getState();
    expect(state.products).toEqual([AFTER_TRANSFORM]);
    expect(state.offline).toBe(true);
    expect(state.error).toBeNull();
    expect(state.loading).toBe(false);
  });

  it('sets error (not offline) when network fails and no cache exists', async () => {
    (supabase.from as jest.Mock).mockReturnValueOnce(
      makeFromChain({ data: null, error: { message: 'Network request failed' } }),
    );
    mockGetProductCache.mockResolvedValueOnce(null);

    await useProductStore.getState().fetchProducts(BUSINESS_ID, USER_ID);

    const state = useProductStore.getState();
    expect(state.products).toEqual([]);
    expect(state.offline).toBe(false);
    expect(state.error).not.toBeNull();
  });

  it('clears the offline flag on the next successful fetch (Fix 3)', async () => {
    useProductStore.setState({ offline: true, products: [AFTER_TRANSFORM] });

    (supabase.from as jest.Mock).mockReturnValueOnce(
      makeFromChain({ data: [RAW_FROM_DB], error: null }),
    );

    await useProductStore.getState().fetchProducts(BUSINESS_ID, USER_ID);

    expect(useProductStore.getState().offline).toBe(false);
  });

  it('does not call getProductCache on a non-network server error', async () => {
    (supabase.from as jest.Mock).mockReturnValueOnce(
      makeFromChain({ data: null, error: { message: 'permission denied for table products' } }),
    );

    await useProductStore.getState().fetchProducts(BUSINESS_ID, USER_ID);

    expect(mockGetProductCache).not.toHaveBeenCalled();
    expect(useProductStore.getState().error).not.toBeNull();
  });
});
