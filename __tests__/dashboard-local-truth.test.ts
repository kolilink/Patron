// The dashboard reads LOCAL truth: server base + what the outbox still holds.
//
// Writes are local-first (outbox), so a server KPI read is always missing the
// queued ops. Accueil therefore shows  base + (overlay list - synced baseline
// list)  — see src/utils/salesTotals.ts. Proven here with the real stores,
// real outbox overlay and the real drain, against an in-memory server whose
// get_dashboard_kpis re-implements the SQL formulas independently (cents):
//   * with pending ops the dashboard equals the list-derived totals and is NOT
//     the (stale) server read;
//   * after the outbox drains and the server is read fresh, it equals that read.

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
      const rows = serverTables.sale_orders;
      if (fn === 'submit_carnet_debt') {
        rows.push(serverSale({ id: `srv-${rows.length + 1}`, status: 'credit', is_credit: true, customer_name: args.p_customer_name, total_amount: args.p_amount }));
        return { data: null, error: null };
      }
      if (fn === 'submit_quick_sale') {
        const id = `srv-${rows.length + 1}`;
        const total = args.p_unit_price * args.p_qty;
        rows.push(serverSale({ id, status: 'paye', is_credit: false, customer_name: null, total_amount: total }));
        serverTables.payments.push({ order_id: id, amount: total });
        return { data: id, error: null };
      }
      if (fn === 'record_client_payment') {
        // FIFO over the customer's open credit orders, like the real RPC.
        let left = args.p_amount;
        const open = rows.filter(r => r.status === 'credit' && r.customer_name === args.p_customer_name)
          .sort((x, y) => x.created_at.localeCompare(y.created_at));
        for (const o of open) {
          const paid = serverTables.payments.filter(p => p.order_id === o.id).reduce((s, p) => s + p.amount, 0);
          const take = Math.min(left, o.total_amount - paid);
          if (take <= 0) continue;
          serverTables.payments.push({ order_id: o.id, amount: take });
          left -= take;
          if (take === o.total_amount - paid) { o.status = 'paye'; o.paid_at = new Date().toISOString(); }
        }
        return { data: { payment_ids: [] }, error: null };
      }
      if (fn === 'get_dashboard_kpis') return { data: serverKpisCents(), error: null };
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
import { salesKpisFromList, applyKpiOverlay } from '@/src/utils/salesTotals';


function serverSale(o: { id: string; status: string; is_credit: boolean; customer_name: string | null; total_amount: number }) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    ...o, business_id: 'biz-1', client_id: null, seller_id: 'user-1', discount_amount: 0,
    paid_at: o.is_credit ? null : new Date().toISOString(), sale_date: today, due_date: null,
    created_at: new Date().toISOString(), cancelled_at: null, cancellation_reason: null, cancelled_by_id: null,
    edit_count: 0, last_edited_at: null, last_edited_by: null,
  };
}


// What the SQL function computes, over the fake server tables (cents).
function serverKpisCents() {
  const today = new Date().toISOString().slice(0, 10);
  const rows = serverTables.sale_orders;
  const net = (r: any) => r.total_amount - (r.discount_amount ?? 0);
  const todayRows = rows.filter(r => r.status !== 'annule' && (r.sale_date ?? r.created_at.slice(0, 10)) === today);
  const paidBy = (id: string) => serverTables.payments.filter(p => p.order_id === id).reduce((s, p) => s + p.amount, 0);
  const credit = rows.filter(r => r.status === 'credit').map(r => ({ name: r.customer_name, remaining: Math.max(0, net(r) - paidBy(r.id)) }));
  const names = new Set(credit.filter(c => c.name && c.remaining > 1).map(c => c.name));
  return {
    revenue_today: todayRows.filter(r => !r.is_credit).reduce((s, r) => s + net(r), 0),
    revenue_yesterday: 0,
    revenue_month: rows.filter(r => r.status === 'paye').reduce((s, r) => s + net(r), 0),
    sales_today: todayRows.length,
    credit_total: credit.reduce((s, c) => s + c.remaining, 0),
    credit_count: names.size + credit.filter(c => !c.name && c.remaining > 1).length,
    expenses_month: 0, low_stock: 0, first_sale_at: null,
  };
}
const serverBase = async () => {
  const { data } = await (require('@/lib/supabase').supabase.rpc('get_dashboard_kpis', {}));
  const d = data as Record<string, number>;
  return {
    revenue_today: d.revenue_today / 100, revenue_yesterday: d.revenue_yesterday / 100, revenue_month: d.revenue_month / 100,
    sales_today: d.sales_today, credit_total: d.credit_total / 100, credit_count: d.credit_count,
  };
};

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

// Exactly what Accueil does: a server base, then base + the outbox.
async function dashboard(base: Awaited<ReturnType<typeof serverBase>>) {
  const { baseline, overlay } = await useVentesStore.getState().readOverlayPair();
  return applyKpiOverlay(base, overlay, baseline);
}
// What the lists (Ventes / carnet) are built from.
const listDerived = () => salesKpisFromList(useVentesStore.getState().sales);

beforeAll(() => {
  jest.useFakeTimers({
    now: new Date('2026-10-04T12:00:00Z'),
    doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask', 'performance', 'hrtime'],
  });
});
afterAll(() => jest.useRealTimers());

describe('dashboard sales + debts read local truth', () => {
  let staleBase: Awaited<ReturnType<typeof serverBase>>;

  it('seeds a synced business: 1 cash sale today (8 000), Aissatou owes 10 000 (2 000 already paid), Moussa owes 5 000', async () => {
    const t = new Date().toISOString();
    serverTables.sale_orders.push(
      { ...serverSale({ id: 'srv-a', status: 'paye', is_credit: false, customer_name: null, total_amount: 800000 }), created_at: t },
      { ...serverSale({ id: 'srv-b', status: 'credit', is_credit: true, customer_name: 'Aissatou', total_amount: 1000000 }), created_at: '2026-10-04T08:00:00.000Z' },
      { ...serverSale({ id: 'srv-c', status: 'credit', is_credit: true, customer_name: 'Moussa', total_amount: 500000 }), created_at: '2026-10-04T09:00:00.000Z' },
    );
    serverTables.payments.push({ order_id: 'srv-a', amount: 800000 }, { order_id: 'srv-b', amount: 200000 });
    net.online = true;
    await useVentesStore.getState().fetchSales('biz-1', undefined);   // warms the synced baseline
    staleBase = await serverBase();
    expect(staleBase).toMatchObject({ sales_today: 3, revenue_today: 8000, credit_total: 13000, credit_count: 2 });
    // synced + empty outbox: the dashboard IS the server read
    expect(await dashboard(staleBase)).toEqual(staleBase);
  });

  it('with pending ops (offline) the dashboard equals the list-derived totals, not the stale server read', async () => {
    net.online = false;
    await useSalesStore.getState().submitQuickSale('biz-1', 'user-1', 450000, 1);               // +4 500 cash
    await useSalesStore.getState().submitCarnetDebt('biz-1', 'user-1', 'Aissatou', 600000, null); // existing debtor: +6 000, count unchanged
    await useSalesStore.getState().submitCarnetDebt('biz-1', 'user-1', 'Nouveau', 300000, null);  // new debtor: +3 000, count +1
    const pay = await useVentesStore.getState().recordClientPayment('Moussa', 'biz-1', 5000, 'especes', '2026-10-04', 'k-pay-1'); // Moussa settles
    expect(pay.ok).toBe(true);
    await flush();
    expect(mockQueue.filter(q => q.status === 'pending')).toHaveLength(4);

    const shown = await dashboard(staleBase);
    expect(shown).toMatchObject({
      sales_today: 6,                       // 3 + quick sale + 2 debts
      revenue_today: 8000 + 4500,           // credit sales are not "revenue today"
      credit_total: 13000 + 6000 + 3000 - 5000,
      credit_count: 2 + 1 - 1,              // Nouveau joins, Moussa settles, Aissatou already counted
    });
    expect(shown).not.toEqual(staleBase);   // never the stale server numbers
    // …and exactly what the lists are built from:
    const lists = listDerived();
    for (const k of ['sales_today', 'revenue_today', 'credit_total', 'credit_count'] as const) {
      expect(shown[k]).toBe(lists[k]);
    }
  });

  it('a new local write moves the dashboard immediately (same base, no server read)', async () => {
    await useSalesStore.getState().submitQuickSale('biz-1', 'user-1', 100000, 1);   // +1 000
    await flush();
    const shown = await dashboard(staleBase);
    expect(shown.revenue_today).toBe(8000 + 4500 + 1000);
    expect(shown.sales_today).toBe(7);
    expect(shown.revenue_today).toBe(listDerived().revenue_today);
  });

  it('after the outbox drains and the server is read fresh, the dashboard equals that read', async () => {
    net.online = true;
    const result = await useSyncStore.getState().sync();
    expect(result.synced).toBe(5);
    expect(mockQueue).toHaveLength(0);
    await useVentesStore.getState().fetchSales('biz-1', undefined);      // synced baseline refreshed
    const fresh = await serverBase();
    const shown = await dashboard(fresh);
    expect(shown).toEqual(fresh);                                          // empty outbox: delta is 0
    expect(fresh).toMatchObject({ sales_today: 7, revenue_today: 8000 + 4500 + 1000, credit_total: 13000 + 6000 + 3000 - 5000, credit_count: 2 });
    const lists = listDerived();
    for (const k of ['sales_today', 'revenue_today', 'credit_total', 'credit_count'] as const) {
      expect(shown[k]).toBe(lists[k]);
    }
  });

  it('a capped local list cannot skew the dashboard: only pending effects are added to the server base', async () => {
    // The server knows a 40 000 debt the local list never loaded (row cap / window).
    const bigBase = { ...(await serverBase()), credit_total: 40000 + 17000, credit_count: 3 };
    net.online = false;
    await useSalesStore.getState().submitCarnetDebt('biz-1', 'user-1', 'Encore', 200000, null);
    await flush();
    const shown = await dashboard(bigBase);
    expect(shown.credit_total).toBe(40000 + 17000 + 2000);   // not recomputed from the partial list
    expect(shown.credit_count).toBe(4);
  });
});
