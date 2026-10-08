// loadDetail is cache-first: a cached detail shows at once and offline, a
// revalidation swaps in place, and offline with nothing cached shows the
// offline empty state flag — never an endless skeleton.
const mockDetail = new Map<string, unknown>();
jest.mock('@/lib/db', () => ({
  saveVentesCache: jest.fn(), getVentesCache: jest.fn(async () => null), getCacheTimestamp: jest.fn(async () => null),
  enqueue: jest.fn(), getQueueCount: jest.fn(async () => 0), getAllQueueItemsForOverlay: async () => ({ ok: [], corrupt: [] }),
  saveSaleDetailCache: async (id: string, v: unknown) => { mockDetail.set(id, JSON.parse(JSON.stringify(v))); },
  getSaleDetailCache: async (id: string) => (mockDetail.has(id) ? JSON.parse(JSON.stringify(mockDetail.get(id))) : null),
}));
let offlineNow = false;
jest.mock('@/lib/connectivity', () => ({ isKnownOffline: () => offlineNow }));
jest.mock('@/lib/outbox', () => ({ enqueueOnce: jest.fn() }));
jest.mock('@/stores/sync', () => ({ useSyncStore: { getState: () => ({ pendingCount: 0, kick: jest.fn() }), setState: jest.fn() } }));
jest.mock('@/stores/auth', () => ({ useAuthStore: { getState: () => ({ session: { activeBusiness: { id: 'b1' }, user: { id: 'u1' } } }) } }));
jest.mock('@/src/utils/notifications', () => ({ notifyEvent: jest.fn() }));
jest.mock('@/lib/analytics', () => ({ trackEvent: jest.fn() }));

let queryImpl: (table: string) => Promise<{ data: any; error: any }> = async () => ({ data: [], error: null });
jest.mock('@/lib/supabase', () => {
  const chain = (table: string): any => {
    const c: any = { select: () => c, eq: () => c, in: () => c, order: () => c, then: (res: any, rej: any) => queryImpl(table).then(res, rej) };
    return c;
  };
  return { supabase: { from: (t: string) => chain(t), rpc: jest.fn() } };
});

import { useVentesStore } from '@/stores/ventes';

const S = () => useVentesStore.getState();
const sale = { id: 's1', business_id: 'b1', total_amount: 100, discount_amount: 0 } as any;
const cachedDetail = {
  lines: [{ id: 'l1', product_id: 'p', product_name: 'Riz', variant_id: null, variant_name: null, qty: 2, unit_price: 50, is_bulk: false, cost_price: 30 }],
  payments: [{ id: 'pay1', method: 'especes', amount: 100, date: '2026-10-01' }],
  amount_paid: 100,
  edits: [],
};
const tick = () => new Promise(r => setImmediate(r));

beforeEach(() => {
  mockDetail.clear(); offlineNow = false;
  queryImpl = async () => ({ data: [], error: null });
  useVentesStore.setState({ sales: [{ ...sale }], detailUnavailable: {} } as any);
});

describe('loadDetail: cache-first', () => {
  it('cached detail renders without waiting for a hung network', async () => {
    mockDetail.set('s1', cachedDetail);
    let release!: (v: any) => void;
    const hung = new Promise<any>(r => { release = r; });
    queryImpl = () => hung;
    const done = S().loadDetail('s1');
    await tick(); await tick();
    expect(S().sales[0].lines).toEqual(cachedDetail.lines);
    expect(S().sales[0].amount_paid).toBe(100);
    expect(S().detailUnavailable.s1).toBeFalsy();
    release({ data: [], error: null });
    await done;
  });

  it('offline with a cached detail: shows the cached lines, no network call', async () => {
    mockDetail.set('s1', cachedDetail);
    offlineNow = true;
    const spy = jest.fn(async () => ({ data: [], error: null }));
    queryImpl = spy;
    await S().loadDetail('s1');
    expect(spy).not.toHaveBeenCalled();
    expect(S().sales[0].lines).toEqual(cachedDetail.lines);
    expect(S().detailUnavailable.s1).toBeFalsy();
  });

  it('offline without a cache: lines stay unset and the offline empty state is flagged', async () => {
    offlineNow = true;
    await S().loadDetail('s1');
    expect(S().sales[0].lines).toBeUndefined();
    expect(S().detailUnavailable.s1).toBe(true);
  });

  it('network failure with a cached detail keeps showing it (never an eternal skeleton)', async () => {
    mockDetail.set('s1', cachedDetail);
    queryImpl = async () => ({ data: null, error: { message: 'Failed to fetch' } });
    await S().loadDetail('s1');
    expect(S().sales[0].lines).toEqual(cachedDetail.lines);
    expect(S().detailUnavailable.s1).toBeFalsy();
  });

  it('network failure without a cache: flagged unavailable', async () => {
    queryImpl = async () => ({ data: null, error: { message: 'Failed to fetch' } });
    await S().loadDetail('s1');
    expect(S().sales[0].lines).toBeUndefined();
    expect(S().detailUnavailable.s1).toBe(true);
  });

  it('revalidation swaps in fresh data without ever clearing the displayed lines', async () => {
    mockDetail.set('s1', cachedDetail);
    const seen: Array<unknown> = [];
    const unsub = useVentesStore.subscribe(st => { seen.push(st.sales[0].lines); });
    queryImpl = async (table) => table === 'so_lines'
      ? { data: [{ id: 'l1', product_id: 'p', product_name: 'Riz', qty: 3, unit_price: 5000, is_bulk: false, cost_price_at_sale: 3000 }], error: null }
      : { data: [], error: null };
    await S().loadDetail('s1');
    unsub();
    expect(seen.every(l => Array.isArray(l) && (l as any[]).length > 0)).toBe(true);
    expect(S().sales[0].lines![0].qty).toBe(3);
    expect(mockDetail.get('s1')).toMatchObject({ lines: [{ qty: 3 }] });   // cache refreshed
  });
});
