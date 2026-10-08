// Stale-while-revalidate for the rapports loaders: cached data renders at once
// (loading=false) before a hung network resolves; a skeleton exists only with
// nothing to show; a revalidation never blanks what is displayed.
const mockCache = new Map<string, unknown>();
jest.mock('@/lib/db', () => ({
  getAllQueueItemsForOverlay: async () => ({ ok: [], corrupt: [] }),
  getRapportsCache: async (k: string) => (mockCache.has(k) ? JSON.parse(JSON.stringify(mockCache.get(k))) : null),
  saveRapportsCache: async (k: string, v: unknown) => { mockCache.set(k, JSON.parse(JSON.stringify(v))); },
  getCacheTimestamp: async () => 1700000000000,
}));
let offlineNow = false;
jest.mock('@/lib/connectivity', () => ({ isKnownOffline: () => offlineNow }));

let rpcImpl: (fn: string) => Promise<{ data: any; error: any }> = async () => ({ data: null, error: null });
const rpcLog: string[] = [];
jest.mock('@/lib/supabase', () => ({
  supabase: { rpc: (fn: string) => { rpcLog.push(fn); return rpcImpl(fn); }, from: () => ({}) },
}));
jest.mock('@/stores/auth', () => ({
  useAuthStore: { getState: () => ({ session: { activeBusiness: { id: 'biz-1' }, activeMembership: { role: 'administrateur' }, user: { id: 'u1', name: 'Fatou' } } }) },
}));
jest.mock('@/stores/ventes', () => ({ useVentesStore: { getState: () => ({ sales: [] }), subscribe: () => () => {} } }));
jest.mock('@/stores/sync', () => ({
  useSyncStore: { getState: () => ({ syncing: false, lastResult: null }), subscribe: () => () => {} },
}));

import { useRapportsStore } from '@/stores/rapports';

const now = new Date();
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const YEAR = now.getFullYear();
const periodRaw = (net: number) => ({
  role: 'administrateur', period_start: `${YEAR}-01-01`, period_end: iso(now), cash_on_hand: 0, net_profit: net, sales_count: 3,
  units_sold: 5, sales_without_cost: 0, credit_outstanding: 0, credit_count: 0, daily: [], my_sales_count: 0, my_units_sold: 0,
  my_credit_pending: 0, my_credit_count: 0, my_daily: [], investor_balance: 0, my_total_invested: 0,
});
const snapRaw = (rev: number) => ({
  role: 'administrateur', period_days: 30, period_start: `${YEAR}-01-01`, revenue: rev, period_order_count: 1, activity: [], top_sellers: [],
});
const S = () => useRapportsStore.getState();
const fetchYear = () => S().fetchYearReport('biz-1', YEAR, 'administrateur', 'u1');
const fetchSnap = () => S().fetchReportsSnapshot('biz-1', 30, 'administrateur', 'u1');
const yearKey = `biz-1:administrateur:u1:${YEAR}-01-01:${iso(now)}`;
const snapKey = 'biz-1:administrateur:u1:30';

// A promise the test resolves by hand: a "hung network".
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const tick = () => new Promise(r => setImmediate(r));

beforeEach(() => {
  mockCache.clear(); offlineNow = false; rpcLog.length = 0;
  rpcImpl = async () => ({ data: null, error: null });
  S().reset();
});

describe('rapports: cache-first', () => {
  it('warm cache + hung network: cached report shown with loading=false BEFORE the network resolves', async () => {
    mockCache.set(yearKey, periodRaw(700000));
    mockCache.set(snapKey, snapRaw(100000));
    const net = deferred<{ data: any; error: any }>();
    rpcImpl = () => net.promise;

    const yearDone = fetchYear(); const snapDone = fetchSnap();
    await tick(); await tick();

    expect(rpcLog.length).toBeGreaterThan(0);                 // the network call really is in flight (hung)
    expect(S().yearReportLoading).toBe(false);
    expect(S().yearReport!.net_profit).toBe(7000);
    expect(S().snapshotLoading).toBe(false);
    expect(S().snapshot!.revenue).toBe(1000);

    net.resolve({ data: periodRaw(900000), error: null });
    await yearDone; await snapDone;
  });

  it('empty cache + hung network: the skeleton (loading=true, no data) — the legitimate case', async () => {
    const net = deferred<{ data: any; error: any }>();
    rpcImpl = () => net.promise;
    const done = fetchYear();
    await tick(); await tick();
    expect(S().yearReportLoading).toBe(true);
    expect(S().yearReport).toBeNull();
    net.resolve({ data: periodRaw(100), error: null });
    await done;
    expect(S().yearReportLoading).toBe(false);
    expect(S().yearReport!.net_profit).toBe(1);
  });

  it('revalidation never blanks: loading stays false throughout and the report is swapped in place', async () => {
    mockCache.set(yearKey, periodRaw(700000));
    await fetchYear();                                         // slot now warm in memory
    const before = S().yearReport;
    const net = deferred<{ data: any; error: any }>();
    rpcImpl = () => net.promise;

    const again = fetchYear();
    await tick(); await tick();
    expect(S().yearReportLoading).toBe(false);
    expect(S().yearReport).toBe(before);                       // referentially stable while revalidating

    net.resolve({ data: periodRaw(800000), error: null });
    await again;
    expect(S().yearReportLoading).toBe(false);
    expect(S().yearReport!.net_profit).toBe(8000);
  });

  it('a failed revalidation keeps the displayed report (field-equal) and flags offline', async () => {
    mockCache.set(yearKey, periodRaw(700000));
    await fetchYear();
    const shown = S().yearReport!.net_profit;
    rpcImpl = async () => ({ data: null, error: { message: 'Failed to fetch', code: '' } });
    await fetchYear();
    expect(S().yearReport!.net_profit).toBe(shown);
    expect(S().yearReportLoading).toBe(false);
    expect(S().periodOffline).toBe(true);
  });

  it('known offline: no network call at all, cache shown, no loading flag', async () => {
    mockCache.set(yearKey, periodRaw(700000));
    mockCache.set(snapKey, snapRaw(100000));
    offlineNow = true;
    await fetchYear(); await fetchSnap();
    expect(rpcLog).toEqual([]);
    expect(S().yearReportLoading).toBe(false);
    expect(S().yearReport!.net_profit).toBe(7000);
    expect(S().periodOffline).toBe(true);
    expect(S().offline).toBe(true);
    expect(S().snapshot!.revenue).toBe(1000);
  });

  it('known offline with nothing cached: offline view, not a skeleton', async () => {
    offlineNow = true;
    await fetchYear();
    expect(rpcLog).toEqual([]);
    expect(S().yearReportLoading).toBe(false);
    expect(S().yearReport).toBeNull();
    expect(S().periodOffline).toBe(true);
  });
});
