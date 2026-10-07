// Rapports read side: displayed = base (server/cache) + delta (outbox), paired.
// Covers the state model (unknown is never zero), cache corruption, the
// drain-mid-fetch double-count, role scoping and the failed_permanent split.

let mockItems: any[] = [];
const mockCache = new Map<string, unknown>();
let mockCacheMode: 'ok' | 'garbage' | 'throw' = 'ok';

jest.mock('@/lib/db', () => ({
  getAllQueueItemsForOverlay: async () => ({ ok: mockItems.map(i => ({ ...i })), corrupt: [] }),
  getRapportsCache: async (k: string) => {
    if (mockCacheMode === 'throw') throw new Error('decrypt failed');
    if (mockCacheMode === 'garbage') return 12345;
    return mockCache.has(k) ? JSON.parse(JSON.stringify(mockCache.get(k))) : null;
  },
  saveRapportsCache: async (k: string, v: unknown) => { mockCache.set(k, JSON.parse(JSON.stringify(v))); },
  getCacheTimestamp: async () => null,
}));

const NETWORK_ERROR = { message: 'Failed to fetch', code: '', details: '', hint: '' };
type RpcImpl = (fn: string, args: any) => Promise<{ data: any; error: any }>;
let rpcImpl: RpcImpl = async () => ({ data: null, error: NETWORK_ERROR });
const rpcLog: string[] = [];
jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (fn: string, args: any) => { rpcLog.push(fn); return rpcImpl(fn, args); },
    from: () => ({}),
  },
}));

let mockRole = 'administrateur';
jest.mock('@/stores/auth', () => ({
  useAuthStore: { getState: () => ({ session: {
    activeBusiness: { id: 'biz-1' }, activeMembership: { role: mockRole }, user: { id: 'u1', name: 'Fatou' },
  } }) },
}));
jest.mock('@/stores/ventes', () => ({ useVentesStore: { getState: () => ({ sales: [] }), subscribe: () => () => {} } }));
const syncState: any = { syncing: false, lastResult: null };
const syncListeners: Array<(s: any, p: any) => void> = [];
jest.mock('@/stores/sync', () => ({
  useSyncStore: {
    getState: () => syncState,
    subscribe: (fn: (s: any, p: any) => void) => { syncListeners.push(fn); return () => {}; },
  },
}));

import { useRapportsStore } from '@/stores/rapports';
import { loadRefusedOps } from '@/lib/pendingOverlay';

const today = new Date();
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const TODAY = iso(today);
const YEAR = today.getFullYear();

const quickItem = (n: number, status = 'pending', cents = 450000, last_error: string | null = null) => ({
  id: n, operation: 'submit_quick_sale', status, attempts: 0, last_error, idempotency_key: `key-${n}`, entity_type: 'vente',
  queued_at: `${TODAY}T09:00:00.000Z`, created_at: `${TODAY}T09:00:00.000Z`, next_attempt_at: `${TODAY}T09:00:00.000Z`,
  payload: JSON.stringify({ p_business_id: 'biz-1', p_seller_id: 'u1', p_unit_price: cents, p_qty: 1, p_label: null, p_idempotency_key: `key-${n}` }),
});


const otherSellerQuick = (n: number, cents = 900000) => ({
  ...quickItem(n),
  payload: JSON.stringify({ p_business_id: 'biz-1', p_seller_id: 'u2', p_unit_price: cents, p_qty: 3, p_label: null, p_idempotency_key: `key-${n}` }),
});
const otherSellerDebt = (n: number, cents = 700000) => ({
  ...quickItem(n), operation: 'submit_carnet_debt', entity_type: 'dette',
  payload: JSON.stringify({ p_business_id: 'biz-1', p_seller_id: 'u2', p_customer_name: 'Client Moussa', p_amount: cents, p_client_id: null, p_idempotency_key: `key-${n}` }),
});

const periodRaw = (over: Record<string, unknown> = {}) => ({
  role: 'administrateur', period_start: `${YEAR}-01-01`, period_end: TODAY, cash_on_hand: 0, net_profit: 700000, sales_count: 3,
  units_sold: 5, sales_without_cost: 0, credit_outstanding: 0, credit_count: 0, daily: [], my_sales_count: 0, my_units_sold: 0,
  my_credit_pending: 0, my_credit_count: 0, my_daily: [], investor_balance: 0, my_total_invested: 0, ...over,
});
const snapRaw = (over: Record<string, unknown> = {}) => ({
  role: 'administrateur', period_days: 30, period_start: `${YEAR}-01-01`, revenue: 100000, period_order_count: 1, activity: [], top_sellers: [], ...over,
});

const fetchYear = () => useRapportsStore.getState().fetchYearReport('biz-1', YEAR, mockRole, 'u1');
const fetchSnap = () => useRapportsStore.getState().fetchReportsSnapshot('biz-1', 30, mockRole, 'u1');
const S = () => useRapportsStore.getState();

beforeEach(() => {
  mockItems = []; mockCache.clear(); mockCacheMode = 'ok'; mockRole = 'administrateur';
  rpcImpl = async () => ({ data: null, error: NETWORK_ERROR }); rpcLog.length = 0;
  syncState.syncing = false; syncState.lastResult = null;
  S().reset();
});

describe('base + overlay', () => {
  it('online: displayed = server report + what the outbox adds; profit untouched, caveat counted', async () => {
    mockItems = [quickItem(1)];
    rpcImpl = async (fn) => ({ data: fn === 'get_period_report' ? periodRaw() : snapRaw(), error: null });
    await fetchYear(); await fetchSnap();
    expect(S().yearReport!.sales_count).toBe(4);
    expect(S().yearReport!.net_profit).toBe(7000);          // 700000 cents → 7000, no estimated profit added
    expect(S().yearReport!.sales_without_cost).toBe(1);
    expect(S().snapshot!.revenue).toBe(1000 + 4500);
  });

  it('offline with a cache: cached base + current outbox (restart-safe, identical)', async () => {
    rpcImpl = async (fn) => ({ data: fn === 'get_period_report' ? periodRaw() : snapRaw(), error: null });
    await fetchYear(); await fetchSnap();               // warms the cache
    mockItems = [quickItem(1)];
    rpcImpl = async () => ({ data: null, error: NETWORK_ERROR });
    S().reset();                                        // "app restart": stores cold, SQLite (cache + outbox) kept
    await fetchYear(); await fetchSnap();
    expect(S().snapshot!.revenue).toBe(5500);
    expect(S().yearReport!.sales_count).toBe(4);
    expect(S().periodOffline).toBe(true);
    expect(S().yearReportError).toBeNull();
  });

  it('a later local write only ADDS; a drain finishing without a refetch opens no gap', async () => {
    rpcImpl = async (fn) => ({ data: fn === 'get_period_report' ? periodRaw() : snapRaw(), error: null });
    mockItems = [quickItem(1)];
    await fetchSnap();
    expect(S().snapshot!.revenue).toBe(5500);
    mockItems = [quickItem(1), quickItem(2)];           // she records another
    await S().refreshOverlay();
    expect(S().snapshot!.revenue).toBe(1000 + 4500 + 4500);
    mockItems = [];                                      // drain completes, nothing refetched yet
    await S().refreshOverlay();
    expect(S().snapshot!.revenue).toBe(10000);           // paired overlay keeps them: no dip
  });
});

describe('state model — unknown is never zero', () => {
  it('RPC fails (non-network) with no cache → error + Réessayer slot, report stays null (no zeros)', async () => {
    rpcImpl = async () => ({ data: null, error: { message: 'permission denied', code: '42501' } });
    await fetchYear(); await fetchSnap();
    expect(S().yearReport).toBeNull();
    expect(S().yearReportError).toEqual(expect.any(String));
    expect(S().yearReportLoading).toBe(false);
    expect(S().snapshot).toBeNull();
    expect(S().snapshotError).toEqual(expect.any(String));
  });

  it('retry after an error recovers', async () => {
    rpcImpl = async () => ({ data: null, error: { message: 'boom', code: 'XX000' } });
    await fetchYear();
    expect(S().yearReportError).not.toBeNull();
    rpcImpl = async () => ({ data: periodRaw(), error: null });
    await fetchYear();
    expect(S().yearReportError).toBeNull();
    expect(S().yearReport!.sales_count).toBe(3);
  });

  it('network failure with no cache → offline state, no report, no error, no zeros', async () => {
    await fetchYear();
    expect(S().yearReport).toBeNull();
    expect(S().periodOffline).toBe(true);
    expect(S().yearReportError).toBeNull();
  });

  it('genuine empty (server says 0 sales) is a real report, not an error', async () => {
    rpcImpl = async () => ({ data: periodRaw({ sales_count: 0, units_sold: 0, net_profit: 0 }), error: null });
    await fetchYear();
    expect(S().yearReport).not.toBeNull();
    expect(S().yearReport!.sales_count).toBe(0);
    expect(S().yearReportError).toBeNull();
  });
});

describe('corrupt snapshot cache is treated as NO cache', () => {
  it.each(['garbage', 'throw'] as const)('%s cache + network down → offline state, never zeros, never a crash', async (mode) => {
    mockCacheMode = mode;
    await expect(fetchYear()).resolves.toBeUndefined();
    await expect(fetchSnap()).resolves.toBeUndefined();
    expect(S().yearReport).toBeNull();
    expect(S().snapshot).toBeNull();
    expect(S().periodOffline).toBe(true);
  });
  it('a cache that parses but is the wrong shape is discarded too', async () => {
    mockCache.set(`biz-1:administrateur:u1:${YEAR}-01-01:${TODAY}`, { hello: 'world' });
    await fetchYear();
    expect(S().yearReport).toBeNull();
    expect(S().periodOffline).toBe(true);
  });
  it('a corrupt cache is refreshed by the next good fetch', async () => {
    mockCacheMode = 'garbage';
    await fetchYear();
    mockCacheMode = 'ok';
    rpcImpl = async () => ({ data: periodRaw(), error: null });
    await fetchYear();
    expect(S().yearReport!.sales_count).toBe(3);
  });
});

describe('drain mid-fetch never double-counts', () => {
  it('the outbox item drains while the request is in flight and the response already includes it → retried, counted once', async () => {
    mockItems = [quickItem(1)];
    let calls = 0;
    rpcImpl = async () => {
      calls += 1;
      if (calls === 1) mockItems = [];                     // drain completes during the first request
      return { data: snapRaw({ revenue: 450000, period_order_count: 1 }), error: null }; // server counts the sale
    };
    await fetchSnap();
    expect(calls).toBe(2);                                  // first response discarded (outbox moved), refetched
    expect(S().snapshot!.revenue).toBe(4500);               // not 9000
  });

  it('a drain running at fetch time is waited out, not raced', async () => {
    mockItems = [quickItem(1)];
    syncState.syncing = true;
    setTimeout(() => { mockItems = []; syncState.syncing = false; }, 200);
    rpcImpl = async () => ({ data: snapRaw({ revenue: 450000, period_order_count: 1 }), error: null });
    await fetchSnap();
    expect(S().snapshot!.revenue).toBe(4500);
  });

  it('a finished drain that changed the outbox (drainEpoch bump) refetches every shown report', async () => {
    rpcImpl = async () => ({ data: periodRaw(), error: null });
    await fetchYear();
    const before = rpcLog.length;
    for (const fn of syncListeners) fn({ drainEpoch: 1 }, { drainEpoch: 0 });
    await new Promise(r => setTimeout(r, 50));
    expect(rpcLog.length).toBeGreaterThan(before);
  });
});

describe('role scoping', () => {
  it('vendeur: my_* move, business-wide fields stay as the server said', async () => {
    mockRole = 'vendeur';
    mockItems = [quickItem(1)];
    rpcImpl = async () => ({ data: periodRaw({ role: 'vendeur', my_sales_count: 2, my_units_sold: 2, sales_count: 0, cash_on_hand: 0 }), error: null });
    await fetchYear();
    expect(S().yearReport!.my_sales_count).toBe(3);
    expect(S().yearReport!.sales_count).toBe(0);
    expect(S().yearReport!.cash_on_hand).toBe(0);
  });

  it("another seller's queued sales are invisible to a vendeur end to end (store → apply → displayed my_*)", async () => {
    mockRole = 'vendeur';
    const vendeurPeriod = { role: 'vendeur', my_sales_count: 2, my_units_sold: 4, my_credit_pending: 1000000, my_credit_count: 1, my_daily: [{ date: TODAY, amount: 300000, sales_count: 1, units_sold: 2 }] };
    const vendeurSnap = { role: 'vendeur', my_revenue: 250000, my_sales_count: 2, my_credit_pending: 1000000, my_credit_count: 1, my_activity: [{ date: TODAY, amount: 250000 }] };
    rpcImpl = async (fn) => ({ data: fn === 'get_period_report' ? periodRaw(vendeurPeriod) : snapRaw(vendeurSnap), error: null });

    // Baseline: nothing queued → the server values, exactly.
    await fetchYear(); await fetchSnap();
    const baseYear = JSON.parse(JSON.stringify(S().yearReport));
    const baseSnap = JSON.parse(JSON.stringify(S().snapshot));
    expect(baseYear.my_sales_count).toBe(2);

    // Only ANOTHER seller's items are queued (a paid sale of 3 units + a credit debt).
    mockItems = [otherSellerQuick(10), otherSellerDebt(11)];
    await fetchYear(); await fetchSnap();
    const y = S().yearReport!; const sn = S().snapshot!;
    // period report my_*
    expect(y.my_sales_count).toBe(baseYear.my_sales_count);   // my_salesCount
    expect(y.my_units_sold).toBe(baseYear.my_units_sold);     // my_unitsSold
    expect(y.my_credit_pending).toBe(baseYear.my_credit_pending); // my_creditDelta
    expect(y.my_daily).toEqual(baseYear.my_daily);            // my_daily
    // snapshot my_*
    expect(sn.my_revenue).toBe(baseSnap.my_revenue);          // my_revenue
    expect(sn.my_sales_count).toBe(baseSnap.my_sales_count);
    expect(sn.my_credit_pending).toBe(baseSnap.my_credit_pending);
    expect(sn.my_credit_count).toBe(baseSnap.my_credit_count);
    expect(sn.my_activity).toEqual(baseSnap.my_activity);
    // ...and nothing business-wide leaks into her view either
    expect(y.sales_count).toBe(baseYear.sales_count);
    expect(y.cash_on_hand).toBe(baseYear.cash_on_hand);
    expect(sn.revenue).toBe(baseSnap.revenue);
    expect(sn.cash_on_hand).toBe(baseSnap.cash_on_hand);

    // Control: her OWN queued sale does move my_* — the filter isn't just zeroing everything.
    mockItems = [otherSellerQuick(10), otherSellerDebt(11), quickItem(12)];
    await S().refreshOverlay();
    expect(S().yearReport!.my_sales_count).toBe(baseYear.my_sales_count + 1);
    expect(S().yearReport!.my_units_sold).toBe(baseYear.my_units_sold + 1);
    expect(S().yearReport!.my_daily.find(d => d.date === TODAY)!.amount).toBe(3000 + 4500);
    expect(S().snapshot!.my_revenue).toBe(2500 + 4500);
    expect(S().snapshot!.my_credit_pending).toBe(baseSnap.my_credit_pending); // her sale was paid, no credit added
  });
  it("a vendeur's offline cache slot is isolated from an admin's (role + user are in the key)", async () => {
    rpcImpl = async () => ({ data: periodRaw(), error: null });
    await fetchYear();                                       // admin slot warmed
    mockRole = 'vendeur';
    rpcImpl = async () => ({ data: null, error: NETWORK_ERROR });
    S().reset();
    await fetchYear();
    expect(S().yearReport).toBeNull();                       // vendeur never sees the admin's cached numbers
  });
});

describe('failed_permanent split', () => {
  it('a refused sale is excluded from Rapports, listed in the notice with its reason', async () => {
    mockItems = [quickItem(1), quickItem(2, 'failed_permanent', 999999, 'Stock insuffisant')];
    rpcImpl = async (fn) => ({ data: fn === 'get_period_report' ? periodRaw() : snapRaw(), error: null });
    await fetchSnap();
    expect(S().snapshot!.revenue).toBe(1000 + 4500);        // 9 999.99 refused sale NOT counted
    const refused = await loadRefusedOps('biz-1');
    expect(refused.map(r => r.reason)).toEqual(['Stock insuffisant']);
  });
});
