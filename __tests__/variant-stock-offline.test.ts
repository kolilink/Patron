// Offline variant sales are gated by cached stock exactly like plain products.

const mockCache = new Map<string, unknown>();
let mockOnline = true;
let mockServerVariants: any[] = [];

jest.mock('@/lib/db', () => ({
  ...jest.requireActual('@/lib/db'),
  saveVariantsCache: async (b: string, p: string, v: unknown) => { mockCache.set(`${b}:${p}`, JSON.parse(JSON.stringify(v))); },
  getVariantsCache: async (b: string, p: string) => (mockCache.has(`${b}:${p}`) ? JSON.parse(JSON.stringify(mockCache.get(`${b}:${p}`))) : null),
  getProductCache: jest.fn().mockResolvedValue(null),
  saveProductCache: jest.fn(),
}));

const NETWORK_ERROR = { message: 'Failed to fetch', code: '', details: '', hint: '' };
jest.mock('@/lib/supabase', () => {
  const chain = (): any => new Proxy({}, {
    get: (_t, prop) => (prop === 'then'
      ? (res: any, rej: any) => Promise.resolve(mockOnline ? { data: mockServerVariants, error: null } : { data: null, error: NETWORK_ERROR }).then(res, rej)
      : () => chain()),
  });
  return {
    supabase: {
      from: () => chain(), rpc: () => chain(),
      auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })) },
    },
  };
});
jest.mock('@/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/lib/posthog', () => ({ posthog: null }));
jest.mock('@/stores/sync', () => ({ useSyncStore: { getState: () => ({ kick: jest.fn() }), setState: jest.fn() } }));
jest.mock('@/src/utils/notifications', () => ({ notifyEvent: jest.fn() }));
jest.mock('@/stores/auth', () => ({
  useAuthStore: { getState: () => ({ session: { activeMembership: { role: 'administrateur' }, activeBusiness: { id: 'biz-1' }, user: { id: 'u1' } } }) },
}));

import { useProductStore } from '@/stores/products';
import { useSalesStore, decrementVariantStock } from '@/stores/sales';

const product: any = { id: 'p1', name: 'Tee-shirt', has_variants: true, stock_qty: 0, unit: 'pcs', sale_price: 10000 };
const row = (id: string, name: string, stock: number) => ({ id, product_id: 'p1', business_id: 'biz-1', name, stock_qty: stock, sale_price: 1000000, cost_price: 500000, archived: false });

beforeEach(() => {
  mockCache.clear(); mockOnline = true;
  mockServerVariants = [row('v-s', 'S', 3), row('v-m', 'M', 0)];
  useProductStore.setState({ variantsByProduct: {} });
  useSalesStore.setState({ cart: [] });
});

describe('variant stock survives going offline', () => {
  it('online fetch caches stock; offline fetch (cold) returns the cached stock', async () => {
    await useProductStore.getState().fetchVariants('p1', 'biz-1');
    useProductStore.setState({ variantsByProduct: {} }); // simulate a cold start
    mockOnline = false;
    const v = await useProductStore.getState().fetchVariants('p1', 'biz-1');
    expect(v.map(x => [x.name, x.stock_qty])).toEqual([['S', 3], ['M', 0]]);
    expect(useProductStore.getState().variantsByProduct.p1).toHaveLength(2);
  });

  it('offline with nothing cached is empty (nothing to sell against), never invented stock', async () => {
    mockOnline = false;
    expect(await useProductStore.getState().fetchVariants('p1', 'biz-1')).toEqual([]);
  });
});

describe('offline variant sale is gated like a product sale', () => {
  it('cart is capped at cached stock (10 requested, 3 in stock → 3)', async () => {
    await useProductStore.getState().fetchVariants('p1', 'biz-1');
    mockOnline = false;
    useProductStore.setState({ variantsByProduct: {} });
    const [s] = await useProductStore.getState().fetchVariants('p1', 'biz-1');
    useSalesStore.getState().addToCartVariant(product, s, 10);
    expect(useSalesStore.getState().cart[0].qty).toBe(3);
    useSalesStore.getState().setQty('p1', 99, false, 'v-s');
    expect(useSalesStore.getState().cart[0].qty).toBe(3);
  });

  it('an exhausted variant cannot enter the cart at all (no 0-quantity line)', async () => {
    await useProductStore.getState().fetchVariants('p1', 'biz-1');
    const m = useProductStore.getState().variantsByProduct.p1.find(v => v.id === 'v-m')!;
    useSalesStore.getState().addToCartVariant(product, m, 1);
    expect(useSalesStore.getState().cart).toEqual([]);
  });

  it('after an offline sale the remaining stock drops, so the next offline sale is capped by what is left', async () => {
    await useProductStore.getState().fetchVariants('p1', 'biz-1');
    mockOnline = false;
    await decrementVariantStock('biz-1', [{ product: { id: 'p1' }, qty: 2, variant_id: 'v-s' }]);
    expect(useProductStore.getState().variantsByProduct.p1.find(v => v.id === 'v-s')!.stock_qty).toBe(1);
    // restart, still offline: the persisted cache carries the reduced stock
    useProductStore.setState({ variantsByProduct: {} });
    const [s] = await useProductStore.getState().fetchVariants('p1', 'biz-1');
    expect(s.stock_qty).toBe(1);
    useSalesStore.getState().addToCartVariant(product, s, 5);
    expect(useSalesStore.getState().cart[0].qty).toBe(1);
  });

  it('decrement never goes negative and ignores plain-product lines', async () => {
    await useProductStore.getState().fetchVariants('p1', 'biz-1');
    await decrementVariantStock('biz-1', [
      { product: { id: 'p1' }, qty: 50, variant_id: 'v-s' },
      { product: { id: 'p2' }, qty: 4 },
    ]);
    expect(useProductStore.getState().variantsByProduct.p1.find(v => v.id === 'v-s')!.stock_qty).toBe(0);
  });
});
