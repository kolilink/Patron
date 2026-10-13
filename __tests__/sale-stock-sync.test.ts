// Vendor-visible contract: the shelf moves BEFORE the success UI renders, survives kill+reopen, and a stale
// refetch can never put the pre-sale quantity back. Real stores + real projector; only I/O is faked
// (an in-memory outbox, a product-cache table, a controllable server).

type Row = { id: number; operation: string; payload: string; entity_type: string; status: string };
let outbox: Row[] = [];
let nextId = 1;
const cache = new Map<string, unknown>();
let online = true;
let serverProducts: any[] = [];
let serverVariants: any[] = [];

jest.mock('@/lib/db', () => ({
  ...jest.requireActual('@/lib/db'),
  enqueue: jest.fn(async (operation: string, payload: unknown) => {
    outbox.push({ id: nextId++, operation, payload: JSON.stringify(payload), entity_type: operation === 'submit_sale' ? 'vente' : 'produit', status: 'pending' });
  }),
  getQueueCount: jest.fn(async () => outbox.length),
  getAllQueueItemsForOverlay: jest.fn(async () => ({ ok: outbox.map(r => ({ ...r })), corrupt: [] })),
  getProductCache: jest.fn(async (b: string) => (cache.has(`p:${b}`) ? JSON.parse(JSON.stringify(cache.get(`p:${b}`))) : null)),
  saveProductCache: jest.fn(async (b: string, v: unknown) => { cache.set(`p:${b}`, JSON.parse(JSON.stringify(v))); }),
  getVariantsCache: jest.fn(async (b: string, p: string) => (cache.has(`v:${b}:${p}`) ? JSON.parse(JSON.stringify(cache.get(`v:${b}:${p}`))) : null)),
  saveVariantsCache: jest.fn(async (b: string, p: string, v: unknown) => { cache.set(`v:${b}:${p}`, JSON.parse(JSON.stringify(v))); }),
  getVentesCache: jest.fn().mockResolvedValue(null),
  saveVentesCache: jest.fn().mockResolvedValue(undefined),
  getCacheTimestamp: jest.fn().mockResolvedValue(null),
  getKV: jest.fn().mockResolvedValue(null),
  setKV: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/supabase', () => {
  const chain = (kind: 'p' | 'v'): any => new Proxy({}, {
    get: (_t, prop) => (prop === 'then'
      ? (res: any, rej: any) => Promise.resolve(online
        ? { data: kind === 'p' ? serverProducts : serverVariants, error: null }
        : { data: null, error: { message: 'Failed to fetch', code: '' } }).then(res, rej)
      : () => chain(kind)),
  });
  return {
    supabase: {
      from: (t: string) => chain(t === 'product_variants' ? 'v' : 'p'),
      rpc: () => chain('p'),
      auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })) },
    },
  };
});
jest.mock('@/stores/sync', () => ({ useSyncStore: { getState: () => ({ kick: jest.fn() }), setState: jest.fn() } }));
jest.mock('@/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/lib/posthog', () => ({ posthog: null }));
jest.mock('@/src/utils/notifications', () => ({ notifyEvent: jest.fn() }));

import { useSalesStore } from '@/stores/sales';
import { useProductStore, refreshStockFromOutbox } from '@/stores/products';
import { useVentesStore } from '@/stores/ventes';
import { useAuthStore } from '@/stores/auth';

const BIZ = 'biz-1';
const prow = (id: string, stock: number, extra: object = {}) => ({
  id, business_id: BIZ, name: id, unit: 'pcs', cost_price: 50000, sale_price: 80000, bulk_price: null, reorder_level: 0,
  stock_qty: stock, archived: false, is_system: false, has_variants: false, ...extra,
});
const vrow = (id: string, stock: number) => ({ id, product_id: 'tee', business_id: BIZ, name: id, stock_qty: stock, sale_price: 1000000, cost_price: 500000, archived: false });

const stockOf = (id: string) => useProductStore.getState().products.find(p => p.id === id)?.stock_qty;
const variantStockOf = (id: string) => useProductStore.getState().variantsByProduct.tee?.find(v => v.id === id)?.stock_qty;

async function sell(productId: string, qty: number, variantId?: string) {
  const product = useProductStore.getState().products.find(p => p.id === productId)!;
  if (variantId) {
    const v = useProductStore.getState().variantsByProduct[productId].find(x => x.id === variantId)!;
    useSalesStore.getState().addToCartVariant(product, v, qty);
  } else {
    for (let i = 0; i < qty; i++) useSalesStore.getState().addToCart(product);
  }
  return useSalesStore.getState().submitSale(BIZ, 'u1', { method: 'especes', amount: 800 * qty });
}

/** The instant the vendor's success UI can render (lastSubmitQueued flips true) — record what the grid says THEN. */
function watchSuccessInstant(read: () => unknown) {
  const seen: unknown[] = [];
  const unsub = useSalesStore.subscribe((s, prev) => { if (s.lastSubmitQueued && !prev.lastSubmitQueued) seen.push(read()); });
  return { seen, stop: unsub };
}

async function coldStart() {
  useProductStore.setState({ products: [], variantsByProduct: {}, productsFetchedFor: null });
}

beforeEach(async () => {
  outbox = []; nextId = 1; cache.clear(); online = true;
  serverProducts = [prow('riz', 1), prow('huile', 10), prow('tee', 0, { has_variants: true })];
  serverVariants = [vrow('v-s', 3), vrow('v-m', 5)];
  useSalesStore.setState({ cart: [], submitting: false, error: null, lastSubmitQueued: false });
  useVentesStore.setState({ sales: [] });
  useAuthStore.setState({
    session: { user: { id: 'u1', name: 'Fatou' }, activeBusiness: { id: BIZ, currency: 'GNF' }, activeMembership: { role: 'administrateur' } },
  } as any);
  useProductStore.setState({ products: [], variantsByProduct: {}, productsFetchedFor: null });
  await useProductStore.getState().fetchProducts(BIZ, 'u1', undefined, 'administrateur');
  await useProductStore.getState().fetchVariants('tee', BIZ);
});

describe('stock moves before the success UI', () => {
  it('sell 1 of a 1-in-stock product (offline): the grid already says 0 when the success sheet can render', async () => {
    online = false;
    const w = watchSuccessInstant(() => stockOf('riz'));
    expect(await sell('riz', 1)).toBe(true);
    w.stop();
    expect(w.seen).toEqual([0]); // asserted AT the success instant, not eventually
    expect(stockOf('riz')).toBe(0);
  });

  it('a variant sale moves the variant shelf before the success UI too', async () => {
    online = false;
    const w = watchSuccessInstant(() => variantStockOf('v-s'));
    await sell('tee', 2, 'v-s');
    w.stop();
    expect(w.seen).toEqual([1]);
    expect(variantStockOf('v-m')).toBe(5); // untouched siblings
  });

  it('the base cache is never polluted: it keeps server truth, the outbox carries the sale', async () => {
    online = false;
    await sell('riz', 1);
    expect((cache.get(`p:${BIZ}`) as any[]).find(p => p.id === 'riz').stock_qty).toBe(1);
    expect((cache.get(`v:${BIZ}:tee`) as any[]).find(v => v.id === 'v-s').stock_qty).toBe(3);
  });
});

describe('consistency over time', () => {
  it('kill + reopen before reconnect: stock is still correct (re-derived from the outbox)', async () => {
    online = false;
    await sell('riz', 1);
    await sell('tee', 2, 'v-s');
    await coldStart();
    await useProductStore.getState().fetchProducts(BIZ, 'u1', undefined, 'administrateur');
    await useProductStore.getState().fetchVariants('tee', BIZ);
    expect(stockOf('riz')).toBe(0);
    expect(variantStockOf('v-s')).toBe(1);
  });

  it('a stale refetch (server still shows pre-sale stock) cannot put the old quantity back', async () => {
    await sell('riz', 1); // online, but the sale is still in the outbox (not drained)
    expect(stockOf('riz')).toBe(0);
    await useProductStore.getState().fetchProducts(BIZ, 'u1', undefined, 'administrateur'); // server says 1
    expect(stockOf('riz')).toBe(0);
    await useProductStore.getState().fetchVariants('tee', BIZ);
    expect(variantStockOf('v-s')).toBe(3); // no variant sale queued → untouched
  });

  it('rapid consecutive sales decrement cumulatively with no lost update', async () => {
    online = false;
    await sell('huile', 2);
    await sell('huile', 3);
    await sell('huile', 1);
    expect(stockOf('huile')).toBe(4);
    await sell('tee', 1, 'v-s');
    await sell('tee', 1, 'v-s');
    expect(variantStockOf('v-s')).toBe(1);
  });

  it('re-projecting is idempotent and race-safe: overlapping refreshes never double-apply or lose a sale', async () => {
    online = false;
    await sell('huile', 2);
    await sell('huile', 3);
    await Promise.all([refreshStockFromOutbox(BIZ), refreshStockFromOutbox(BIZ), refreshStockFromOutbox(BIZ)]);
    expect(stockOf('huile')).toBe(5);
  });

  it('reconnect + sync: the drained sale leaves the outbox, the server value agrees with the local one', async () => {
    online = false;
    await sell('riz', 1);
    await sell('tee', 2, 'v-s');
    // sync lands: outbox empty, server now holds the decremented quantities
    outbox = [];
    online = true;
    serverProducts = [prow('riz', 0), prow('huile', 10), prow('tee', 0, { has_variants: true })];
    serverVariants = [vrow('v-s', 1), vrow('v-m', 5)];
    await useProductStore.getState().fetchProducts(BIZ, 'u1', undefined, 'administrateur');
    await useProductStore.getState().fetchVariants('tee', BIZ);
    expect(stockOf('riz')).toBe(0); // not -1, not double-subtracted
    expect(variantStockOf('v-s')).toBe(1);
  });

  it('never goes negative', async () => {
    online = false;
    await sell('riz', 1);
    await sell('riz', 1); // second sale of an already-empty shelf (sold elsewhere / forced)
    expect(stockOf('riz')).toBe(0);
  });
});

describe('cancelling a sale gives the stock back', () => {
  it('cancelled while still queued: net zero, the shelf is back at once (nothing ever reached the server)', async () => {
    online = false;
    await sell('riz', 1);
    expect(stockOf('riz')).toBe(0);
    const key = JSON.parse(outbox[0].payload).p_idempotency_key;
    await useVentesStore.getState().cancelSale(key, BIZ, 'u1', 'erreur');
    expect(stockOf('riz')).toBe(1);
    await coldStart();
    await useProductStore.getState().fetchProducts(BIZ, 'u1', undefined, 'administrateur');
    expect(stockOf('riz')).toBe(1); // survives kill + reopen
  });

  it('synced sale cancelled offline: lines captured at enqueue restock it, variants too', async () => {
    serverProducts = [prow('riz', 0), prow('huile', 10), prow('tee', 0, { has_variants: true })];
    serverVariants = [vrow('v-s', 1), vrow('v-m', 5)];
    await useProductStore.getState().fetchProducts(BIZ, 'u1', undefined, 'administrateur');
    await useProductStore.getState().fetchVariants('tee', BIZ);
    useVentesStore.setState({ sales: [{ id: 's-synced', business_id: BIZ, seller_id: 'u1', status: 'paye', total_amount: 800, lines: [
      { id: 'l1', product_id: 'riz', product_name: 'riz', qty: 1, unit_price: 800, is_bulk: false, cost_price: 500 },
      { id: 'l2', product_id: 'tee', variant_id: 'v-s', product_name: 'tee', qty: 2, unit_price: 800, is_bulk: false, cost_price: 500 },
    ] } as any] });
    online = false;
    const seen: unknown[] = [];
    await useVentesStore.getState().cancelSale('s-synced', BIZ, 'u1', 'erreur');
    seen.push(stockOf('riz'), variantStockOf('v-s'));
    expect(seen).toEqual([1, 3]);
    expect(JSON.stringify(outbox[0].payload)).toContain('_stock_lines');
  });

  it('lines unknown → conservative: nothing restored (stock may read low, never high)', async () => {
    serverProducts = [prow('riz', 0), prow('huile', 10), prow('tee', 0, { has_variants: true })];
    await useProductStore.getState().fetchProducts(BIZ, 'u1', undefined, 'administrateur');
    useVentesStore.setState({ sales: [{ id: 's-x', business_id: BIZ, seller_id: 'u1', status: 'paye', total_amount: 800 } as any] });
    online = false;
    await useVentesStore.getState().cancelSale('s-x', BIZ, 'u1', 'erreur');
    expect(stockOf('riz')).toBe(0);
  });

  it('the drain strips the local-only hint before calling the RPC', () => {
    const sync = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib/sync.ts'), 'utf8');
    expect(sync).toContain('_stock_lines: _ignored');
  });
});

describe('structure: no fire-and-forget stock write left in submitSale', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'stores/sales.ts'), 'utf8');
  it('the stock projection is awaited before the success state is set; the ad-hoc IIFE and decrementVariantStock are gone', () => {
    expect(src).not.toContain('void (async () => {');
    expect(src).not.toContain('decrementVariantStock');
    expect(src.indexOf('await refreshStockFromOutbox(businessId)')).toBeGreaterThan(-1);
    expect(src.indexOf('await refreshStockFromOutbox(businessId)')).toBeLessThan(src.indexOf('lastSubmitQueued: true'));
  });
});
