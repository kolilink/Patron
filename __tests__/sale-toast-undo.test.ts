// Vendor-visible contract: the shelf moves BEFORE the success UI renders, survives kill+reopen, and a stale
// refetch can never put the pre-sale quantity back. Real stores + real projector; only I/O is faked
// (an in-memory outbox, a product-cache table, a controllable server).

type Row = { id: number; operation: string; payload: string; entity_type: string; status: string; idempotency_key: string | null };
let outbox: Row[] = [];
let nextId = 1;
const cache = new Map<string, unknown>();
let online = true;
let serverProducts: any[] = [];
let serverVariants: any[] = [];

jest.mock('@/lib/db', () => ({
  ...jest.requireActual('@/lib/db'),
  enqueue: jest.fn(async (operation: string, payload: unknown) => {
    outbox.push({ id: nextId++, operation, payload: JSON.stringify(payload), entity_type: operation === 'submit_sale' ? 'vente' : operation === 'cancel_sale' ? 'annulation' : 'produit', status: 'pending', idempotency_key: ((payload as Record<string, unknown>).p_idempotency_key as string | undefined) ?? null });
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
import { useProductStore } from '@/stores/products';
import { useVentesStore } from '@/stores/ventes';
import { useAuthStore } from '@/stores/auth';
import { useToastStore, toast } from '@/stores/toast';
import { saleToastSpec } from '@/src/utils/saleToast';

const BIZ = 'biz-1';
const prow = (id: string, stock: number) => ({
  id, business_id: BIZ, name: id, unit: 'pcs', cost_price: 50000, sale_price: 200000, bulk_price: null, reorder_level: 0,
  stock_qty: stock, archived: false, is_system: false, has_variants: false,
});
const stockOf = (id: string) => useProductStore.getState().products.find(p => p.id === id)?.stock_qty;

beforeEach(async () => {
  outbox = []; nextId = 1; cache.clear(); online = false;
  serverProducts = [prow('riz', 5)];
  serverVariants = [];
  useToastStore.getState().clear();
  useSalesStore.setState({ cart: [], submitting: false, error: null, lastSubmitQueued: false });
  useVentesStore.setState({ sales: [] });
  useAuthStore.setState({
    session: { user: { id: 'u1', name: 'Fatou' }, activeBusiness: { id: BIZ, currency: 'GNF' }, activeMembership: { role: 'administrateur' } },
  } as any);
  useProductStore.setState({ products: [], variantsByProduct: {}, productsFetchedFor: null });
  online = true;
  await useProductStore.getState().fetchProducts(BIZ, 'u1', undefined, 'administrateur');
  online = false;
});

async function sellTwo() {
  const product = useProductStore.getState().products.find(p => p.id === 'riz')!;
  useSalesStore.getState().addToCart(product);
  useSalesStore.getState().addToCart(product);
  await useSalesStore.getState().submitSale(BIZ, 'u1', { method: 'especes', amount: 4000 });
  return useSalesStore.getState().lastSaleKey!;
}

describe('the post-sale toast: "Annuler" is a real reversal', () => {
  it('the toast says what was saved; Annuler reverses the sale AND gives the stock back', async () => {
    const key = await sellTwo();
    expect(stockOf('riz')).toBe(3);
    const spec = saleToastSpec({ saleKey: key, businessId: BIZ, userId: 'u1', currency: 'GNF', netAmount: 4000, isCredit: false });
    expect(spec.message).toBe('Enregistré — vente de 4\u00A0000 GNF.');
    const id = toast.saved(spec);
    expect(useToastStore.getState().toasts[0].action?.label).toBe('Annuler');

    await useToastStore.getState().runAction(id);

    // 1. a real cancel_sale op is in the outbox, targeting this sale's local id
    const cancel = outbox.find(o => o.operation === 'cancel_sale');
    expect(cancel).toBeTruthy();
    const payload = JSON.parse(cancel!.payload);
    expect(payload.p_sale_id).toBe(key);
    expect(payload._sale_key).toBe(key);          // the drain resolves the server id from the idempotency key
    // 2. the shelf is back, immediately (asserted now, not eventually)
    expect(stockOf('riz')).toBe(5);
    // 3. the sale shows as cancelled, and is no longer revenue
    const sale = useVentesStore.getState().sales.find(s => s.id === key);
    expect(sale?.status).toBe('annule');
    // 4. the pill is gone
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('survives kill + reopen: stock stays restored (re-derived from the outbox)', async () => {
    const key = await sellTwo();
    await saleToastSpec({ saleKey: key, businessId: BIZ, userId: 'u1', currency: 'GNF', netAmount: 4000, isCredit: false }).undo!();
    useProductStore.setState({ products: [], productsFetchedFor: null });
    await useProductStore.getState().fetchProducts(BIZ, 'u1', undefined, 'administrateur');
    expect(stockOf('riz')).toBe(5);
  });

  it('a credit sale names the client in the toast', () => {
    expect(saleToastSpec({ saleKey: 'k', businessId: BIZ, userId: 'u1', currency: 'GNF', netAmount: 3000, isCredit: true, customerName: 'Awa' }).message)
      .toBe('Enregistré — Awa vous doit 3\u00A0000 GNF.');
  });

  it('the drain strips local hints and resolves the real sale id from the key before cancel_sale', () => {
    const sync = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib/sync.ts'), 'utf8');
    expect(sync).toContain("_sale_key: saleKey");
    expect(sync).toContain(".eq('idempotency_key', saleKey)");
    expect(sync).toContain('rpcArgs.p_sale_id = row.id');
  });
});
