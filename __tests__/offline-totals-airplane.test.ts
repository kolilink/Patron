// Automated airplane-mode proof (offline-first rewrite): with the network
// layer blocked, a recorded sale must show identical totals on Home, Ventes
// and the client carnet; survive an app restart (stores reloaded from the
// durable SQLite state, still offline) unchanged; and not double-count once
// the network returns and the outbox drains.
//
// What is real here: stores/sales, stores/ventes, stores/sync, stores/rapports,
// lib/sync (drainQueue), lib/pendingOverlay, and the exact total derivations
// the screens run (src/utils/salesTotals). What is faked: the network
// (supabase client) and SQLite (an in-memory stand-in with the same queue/
// cache semantics — it survives a simulated restart because it lives outside
// the stores). The physical-device airplane-mode test remains separate.
//
// KNOWN GAP (Phase 1): Rapports offline serves the last cached server
// snapshot with NO pending-sale overlay, so it cannot match the other three
// surfaces until the shared report-delta builder lands. Pinned below as
// `it.failing` so it flips loudly when that is fixed.

const mockQueue: any[] = [];
let mockNextId = 1;
const mockKv = new Map<string, string>();
const mockVentesCache = new Map<string, unknown>();
const mockRapportsCache = new Map<string, unknown>();

jest.mock('@/lib/db', () => ({
  ...jest.requireActual('@/lib/db'),
  enqueue: async (operation: string, payload: Record<string, unknown>) => {
    mockQueue.push({
      id: mockNextId++, operation, payload: JSON.stringify(payload), status: 'pending', attempts: 0,
      last_error: null, next_attempt_at: '2000-01-01T00:00:00.000Z',
      queued_at: new Date().toISOString(), created_at: new Date().toISOString(),
      entity_type: 'vente', idempotency_key: (payload.p_idempotency_key as string) ?? null,
    });
  },
  getAllQueueItemsForOverlay: async () => ({ ok: mockQueue.filter(q => q.status === 'pending').map(q => ({ ...q })), corrupt: [] }),
  getPendingOpsForDrain: async () => ({ ok: mockQueue.filter(q => q.status === 'pending').map(q => ({ ...q })), corrupt: [] }),
  deleteQueueItem: async (id: number) => { const i = mockQueue.findIndex(q => q.id === id); if (i >= 0) mockQueue.splice(i, 1); },
  rescheduleOp: async (id: number) => { const q = mockQueue.find(x => x.id === id); if (q) q.attempts++; },
  markOpPermanentlyFailed: async (id: number) => { const q = mockQueue.find(x => x.id === id); if (q) q.status = 'failed_permanent'; },
  markOpCorrupt: async (id: number) => { const q = mockQueue.find(x => x.id === id); if (q) q.status = 'failed_corrupt'; },
  getQueueCount: async () => mockQueue.filter(q => q.status === 'pending').length,
  getFailedQueueCount: async () => 0,
  getVentesCache: async (k: string) => (mockVentesCache.has(k) ? JSON.parse(JSON.stringify(mockVentesCache.get(k))) : null),
  saveVentesCache: async (k: string, v: unknown) => { mockVentesCache.set(k, JSON.parse(JSON.stringify(v))); },
  getRapportsCache: async (k: string) => (mockRapportsCache.has(k) ? JSON.parse(JSON.stringify(mockRapportsCache.get(k))) : null),
  saveRapportsCache: async (k: string, v: unknown) => { mockRapportsCache.set(k, JSON.parse(JSON.stringify(v))); },
  getCacheTimestamp: async () => null,
  getKV: async (k: string) => mockKv.get(k) ?? null,
  setKV: async (k: string, v: string) => { mockKv.set(k, v); },
}));

// ── Network layer ─────────────────────────────────────────────────────────
const net = { online: true };
const NETWORK_ERROR = { message: 'Failed to fetch', code: '', details: '', hint: '' };
const serverTables: Record<string, any[]> = { sale_orders: [], so_lines: [], payments: [], profiles: [], memberships: [] };
const rpcCalls: { fn: string; args: any }[] = [];
let serverSnapshotRevenueCents = 0;
const writeCalls = () => rpcCalls.filter(c => c.fn.startsWith('submit_'));

function builderFor(table: string) {
  const resolveRows = () => (net.online
    ? { data: serverTables[table] ?? [], error: null }
    : { data: null, error: NETWORK_ERROR });
  const b: any = new Proxy(() => undefined, {
    get: (_t, prop) => {
      if (prop === 'then') return (res: any, rej: any) => Promise.resolve(resolveRows()).then(res, rej);
      return () => b;
    },
  });
  return b;
}

jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => builderFor(table),
    rpc: async (fn: string, args: any) => {
      if (!net.online) throw new Error('Network request failed');
      rpcCalls.push({ fn, args });
      if (fn === 'submit_carnet_debt') {
        serverTables.sale_orders.push(serverSale({
          id: `srv-${serverTables.sale_orders.length + 1}`, status: 'credit', is_credit: true,
          customer_name: args.p_customer_name, total_amount: args.p_amount,
        }));
        serverSnapshotRevenueCents += args.p_amount;
        return { data: null, error: null };
      }
      if (fn === 'submit_quick_sale') {
        const id = `srv-${serverTables.sale_orders.length + 1}`;
        const total = args.p_unit_price * args.p_qty;
        serverTables.sale_orders.push(serverSale({ id, status: 'paye', is_credit: false, customer_name: null, total_amount: total }));
        serverTables.payments.push({ order_id: id, amount: total });
        serverSnapshotRevenueCents += total;
        return { data: id, error: null };
      }
      if (fn === 'get_reports_snapshot') {
        return { data: { role: 'administrateur', period_days: 30, revenue: serverSnapshotRevenueCents }, error: null };
      }
      return { data: null, error: null };
    },
    auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })) },
  },
}));

jest.mock('@/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/lib/posthog', () => ({ posthog: null }));
jest.mock('@/src/utils/notifications', () => ({ notifyEvent: jest.fn(), resolveSellerDisplayName: jest.fn().mockResolvedValue('Fatou') }));

const mockSession = {
  activeBusiness: { id: 'biz-1', currency: 'GNF' },
  activeMembership: { role: 'administrateur', id: 'm-1' },
  user: { id: 'user-1', name: 'Fatou' },
};
jest.mock('@/stores/auth', () => ({ useAuthStore: { getState: () => ({ session: mockSession }), setState: jest.fn() } }));

import { useSalesStore } from '@/stores/sales';
import { useVentesStore } from '@/stores/ventes';
import { useSyncStore } from '@/stores/sync';
import { useRapportsStore } from '@/stores/rapports';
import { useProductStore } from '@/stores/products';
import { computeLocalKpis, activeSalesTotals, selectClientSales, clientBalance } from '@/src/utils/salesTotals';

function serverSale(o: { id: string; status: string; is_credit: boolean; customer_name: string | null; total_amount: number }) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    ...o, business_id: 'biz-1', client_id: null, seller_id: 'user-1', discount_amount: 0,
    paid_at: o.is_credit ? null : new Date().toISOString(), sale_date: today, due_date: null,
    created_at: new Date().toISOString(), cancelled_at: null, cancellation_reason: null, cancelled_by_id: null,
    edit_count: 0, last_edited_at: null, last_edited_by: null,
  };
}

const initialStores = {
  sales: useSalesStore.getState(), ventes: useVentesStore.getState(),
  sync: useSyncStore.getState(), rapports: useRapportsStore.getState(), products: useProductStore.getState(),
};
// App restart: every in-memory store back to its pristine state. mockQueue and
// the cache maps (the "SQLite") deliberately survive.
function simulateRestart() {
  useSalesStore.setState(initialStores.sales, true);
  useVentesStore.setState(initialStores.ventes, true);
  useSyncStore.setState(initialStores.sync, true);
  useRapportsStore.setState(initialStores.rapports, true);
  useProductStore.setState(initialStores.products, true);
}

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

async function loadAllScreens() {
  await useVentesStore.getState().fetchSales('biz-1', undefined);
  await useRapportsStore.getState().fetchReportsSnapshot('biz-1', 30, 'administrateur', 'user-1');
}

function totalsSeenByScreens() {
  const sales = useVentesStore.getState().sales;
  const home = computeLocalKpis({ cached: null, sales, products: [], variantsByProduct: {} });
  const ventes = activeSalesTotals(sales);
  const carnet = clientBalance(selectClientSales(sales, 'Aissatou', false, ''), []);
  return {
    homeCreditTotal: home.credit_total,
    homeRevenueToday: home.revenue_today,
    homeSalesToday: home.sales_today,
    ventesCount: ventes.count,
    ventesTotal: ventes.total,
    carnetOwed: carnet.totalOwed,
    saleIds: sales.map(s => s.id).sort(),
  };
}

const DEBT = 10000;       // GNF, carnet credit to Aissatou
const QUICK = 4500;       // GNF, quick cash sale

let offlineTotals: ReturnType<typeof totalsSeenByScreens>;

beforeAll(() => {
  jest.useFakeTimers({
    now: new Date('2026-10-04T12:00:00Z'),
    doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask', 'performance', 'hrtime'],
  });
});
afterAll(() => jest.useRealTimers());

describe('airplane mode: record a sale offline', () => {
  it('step 0 — online baseline with an empty business warms the caches', async () => {
    net.online = true;
    await loadAllScreens();
    expect(useVentesStore.getState().sales).toEqual([]);
    expect(useRapportsStore.getState().snapshot?.revenue).toBe(0);
  });

  it('step 1 — offline: Home, Ventes and Carnet show identical totals right after recording', async () => {
    net.online = false;
    expect(await useSalesStore.getState().submitCarnetDebt('biz-1', 'user-1', 'Aissatou', DEBT * 100, null)).toBe(true);
    expect(await useSalesStore.getState().submitQuickSale('biz-1', 'user-1', QUICK * 100, 1)).toBe(true);
    await flush(); // the kick()ed drain attempts and fails on the blocked network
    await loadAllScreens();

    offlineTotals = totalsSeenByScreens();
    expect(offlineTotals).toMatchObject({
      homeCreditTotal: DEBT, homeRevenueToday: QUICK, homeSalesToday: 2,
      ventesCount: 2, ventesTotal: DEBT + QUICK,
      carnetOwed: DEBT,
    });
    expect(useVentesStore.getState().offline).toBe(true);
    expect(writeCalls()).toEqual([]);              // nothing reached the server
    expect(mockQueue.filter(q => q.status === 'pending')).toHaveLength(2);
  });

  it('step 2 — app restart, still offline: stores reload from SQLite and totals are identical', async () => {
    simulateRestart();
    expect(useVentesStore.getState().sales).toEqual([]); // really cold
    await loadAllScreens();
    expect(totalsSeenByScreens()).toEqual(offlineTotals);
    expect(writeCalls()).toEqual([]);
  });

  it('step 3 — network returns and the outbox drains: totals do not move, nothing double-counted', async () => {
    net.online = true;
    // Exactly what app/(app)/_layout.tsx's trySync does on foreground.
    const result = await useSyncStore.getState().sync();
    expect(result.synced).toBe(2);
    expect(totalsSeenByScreens()).toEqual(offlineTotals); // before any refetch (in-memory overlay)

    await useVentesStore.getState().fetchSales('biz-1', undefined); // layout refetches after synced > 0
    const after = totalsSeenByScreens();
    expect({ ...after, saleIds: undefined }).toEqual({ ...offlineTotals, saleIds: undefined });
    expect(after.saleIds).toHaveLength(2);          // server rows replaced the pending ones, no duplicates
    expect(rpcCalls.filter(c => c.fn === 'submit_carnet_debt')).toHaveLength(1);
    expect(rpcCalls.filter(c => c.fn === 'submit_quick_sale')).toHaveLength(1);
    expect(mockQueue).toHaveLength(0);
    expect(useSyncStore.getState().pendingCount).toBe(0);

    // A second drain with an empty queue is a no-op.
    await useSyncStore.getState().sync();
    expect(writeCalls()).toHaveLength(2);
  });

  it('step 4 — online Rapports (server snapshot) agrees with the same total once synced', async () => {
    await useRapportsStore.getState().fetchReportsSnapshot('biz-1', 30, 'administrateur', 'user-1');
    expect(useRapportsStore.getState().snapshot?.revenue).toBe(DEBT + QUICK);
  });
});

describe('Rapports offline parity — KNOWN GAP (Phase 1 shared report-delta builder)', () => {
  // Offline Rapports = last cached server snapshot with no pending overlay, so
  // a sale recorded offline is absent from it. Flip to a normal `it` when the
  // shared builder lands and Rapports consumes it.
  it.failing('Rapports shows the same total as Home/Ventes/Carnet for a sale recorded offline', async () => {
    mockQueue.length = 0;
    serverTables.sale_orders.length = 0; serverTables.payments.length = 0; serverSnapshotRevenueCents = 0;
    simulateRestart();
    net.online = true;
    await loadAllScreens();                // warm caches at 0
    net.online = false;
    await useSalesStore.getState().submitQuickSale('biz-1', 'user-1', QUICK * 100, 1);
    await flush();
    await loadAllScreens();
    expect(useVentesStore.getState().sales.length).toBe(1);
    expect(useRapportsStore.getState().snapshot?.revenue).toBe(QUICK);
  });
});
