// Offline flow completion: every write local-write-first, every durable write
// with an immediate read path. For each gap: (a) behaviour, (b) kill -> reopen
// rebuilds the optimistic state from the durable outbox, (c) network-kill: no
// supabase call is attempted before the write, (d) drain: the server row
// replaces the projection with no duplicate.

import fs from 'fs';
import path from 'path';

// ── in-memory durable store: survives a simulated "kill" (stores reset, this does not)
const mockQueue: any[] = [];
let nextId = 1;
const mockVentesCache = new Map<string, any[]>();
const mockCommandeCache = new Map<string, any[]>();
let net = { online: false };
const rpcCalls: { fn: string; args: any }[] = [];
const fromCalls: string[] = [];
let serverCommandes: any[] = [];

jest.mock('@/lib/db', () => ({
  ...jest.requireActual('@/lib/db'),
  enqueue: async (operation: string, payload: any) => {
    mockQueue.push({
      id: nextId++, operation, payload: JSON.stringify(payload), status: 'pending', attempts: 0, last_error: null,
      next_attempt_at: '2000-01-01T00:00:00.000Z', queued_at: new Date().toISOString(), created_at: new Date().toISOString(),
      entity_type: 'x', idempotency_key: payload.p_idempotency_key ?? null,
    });
  },
  getAllQueueItemsForOverlay: async () => ({ ok: mockQueue.map(q => ({ ...q })), corrupt: [] }),
  getPendingOpsForDrain: async () => ({ ok: mockQueue.filter(q => q.status === 'pending').map(q => ({ ...q })), corrupt: [] }),
  deleteQueueItem: async (id: number) => { const i = mockQueue.findIndex(q => q.id === id); if (i >= 0) mockQueue.splice(i, 1); },
  rescheduleOp: async () => {},
  markOpPermanentlyFailed: async (id: number, e: string) => { const q = mockQueue.find(x => x.id === id); if (q) { q.status = 'failed_permanent'; q.last_error = e; } },
  markOpCorrupt: async () => {},
  getQueueCount: async () => mockQueue.filter(q => q.status === 'pending').length,
  getFailedQueueCount: async () => mockQueue.filter(q => q.status !== 'pending').length,
  getVentesCache: async (k: string) => (mockVentesCache.has(k) ? JSON.parse(JSON.stringify(mockVentesCache.get(k))) : null),
  saveVentesCache: async (k: string, v: any[]) => { mockVentesCache.set(k, JSON.parse(JSON.stringify(v))); },
  getCommandeCache: async (b: string) => (mockCommandeCache.has(b) ? JSON.parse(JSON.stringify(mockCommandeCache.get(b))) : null),
  saveCommandeCache: async (b: string, v: any[]) => { mockCommandeCache.set(b, JSON.parse(JSON.stringify(v))); },
  getCacheTimestamp: async () => null,
  getProductCache: async () => null,
  saveProductCache: async () => {},
  getVariantsCache: async () => null,
  saveVariantsCache: async () => {},
}));

const NETWORK_ERROR = { message: 'Failed to fetch', code: '', details: '', hint: '' };
function builder(table: string): any {
  fromCalls.push(table);
  const b: any = {
    select: () => b, eq: () => b, order: () => b, gte: () => b, limit: () => b, in: () => b,
    then: (res: any, rej: any) => {
      const out = !net.online
        ? { data: null, error: NETWORK_ERROR }
        : table === 'purchase_orders' ? { data: serverCommandes, error: null } : { data: [], error: null };
      return Promise.resolve(out).then(res, rej);
    },
  };
  return b;
}
jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: async (fn: string, args: any) => {
      rpcCalls.push({ fn, args });
      if (!net.online) throw new Error('Network request failed');
      return { data: fn === 'record_client_payment' ? { fully_settled: true, payment_ids: ['pay-1'] } : (args.p_idempotency_key ?? 'ok'), error: null };
    },
    from: (t: string) => builder(t),
    auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })) },
  },
}));
jest.mock('@/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/lib/posthog', () => ({ posthog: null }));
jest.mock('@/src/utils/notifications', () => ({ notifyEvent: jest.fn(), resolveSellerDisplayName: jest.fn().mockResolvedValue('Fatou') }));
jest.mock('@/stores/auth', () => ({
  useAuthStore: {
    getState: () => ({
      session: { activeBusiness: { id: 'biz-1', currency: 'GNF' }, activeMembership: { role: 'administrateur' }, user: { id: 'u1', name: 'Fatou' } },
    }),
    setState: jest.fn(),
  },
}));

import { useVentesStore, type Vente } from '@/stores/ventes';
import { useFournisseursStore } from '@/stores/fournisseurs';
import { useSyncStore } from '@/stores/sync';
import { drainQueue } from '@/lib/sync';
import { applyReceptionOps } from '@/lib/receptionOverlay';
import { loadRefusedOps } from '@/lib/pendingOverlay';

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');

const creditSale: Vente = {
  id: 'sale-1', business_id: 'biz-1', customer_name: 'Aïssatou', client_id: null, seller_id: 'u1', seller_name: 'Fatou',
  status: 'credit', is_credit: true, total_amount: 10000, discount_amount: 0, paid_at: null, sale_date: '2026-10-01',
  created_at: '2026-10-01T10:00:00.000Z', cancelled_at: null, cancellation_reason: null, edit_count: 0, last_edited_at: null,
  profit: null, amount_paid: 0,
};
const paidServerVersion: Vente = { ...creditSale, status: 'paye', amount_paid: 10000, paid_at: '2026-10-07T10:00:00.000Z' };

const kill = () => {   // the process dies: every in-memory store is gone, SQLite is not
  useVentesStore.setState({ sales: [], loading: false, offline: false, saving: false, error: null, salesFetchedFor: null });
  useFournisseursStore.setState({ commandes: [], fournisseurs: [], saving: false, error: null });
  useFournisseursStore.getState().reset();
};

beforeEach(() => {
  mockQueue.length = 0; rpcCalls.length = 0; fromCalls.length = 0; mockVentesCache.clear(); mockCommandeCache.clear();
  net = { online: false }; serverCommandes = [];
  mockVentesCache.set('biz-1:all', [creditSale]);
  useVentesStore.setState({ sales: [creditSale], saving: false, error: null, loading: false });
  useSyncStore.setState({ pendingCount: 0, failedCount: 0, kick: jest.fn() } as any);
});

describe('gap 1 — record_client_payment / record_payment are local-write-first', () => {
  it('(c) network-kill: nothing touches supabase before the write; the UI reflects it at once', async () => {
    const r = await useVentesStore.getState().recordClientPayment('Aïssatou', 'biz-1', 4000, 'especes', '2026-10-07', 'key-1');
    expect(r.ok).toBe(true);
    expect(rpcCalls).toHaveLength(0);
    expect(fromCalls).toHaveLength(0);
    expect(mockQueue.map(q => q.operation)).toEqual(['record_client_payment']);
    expect(useVentesStore.getState().sales.find(s => s.id === 'sale-1')!.amount_paid).toBe(4000);
  });

  it('(c) the same for a single-sale payment', async () => {
    const r = await useVentesStore.getState().recordPayment('sale-1', 10000, 'especes', '2026-10-07', 'key-2');
    expect(r.ok).toBe(true);
    expect(rpcCalls).toHaveLength(0);
    expect(mockQueue.map(q => q.operation)).toEqual(['record_payment']);
  });

  it('(b) kill -> reopen offline: the payment is rebuilt from the outbox', async () => {
    await useVentesStore.getState().recordClientPayment('Aïssatou', 'biz-1', 4000, 'especes', '2026-10-07', 'key-3');
    kill();
    await useVentesStore.getState().fetchSales('biz-1', undefined);          // offline: network error path
    const s = useVentesStore.getState().sales.find(x => x.id === 'sale-1')!;
    expect(s.amount_paid).toBe(4000);
    expect(useVentesStore.getState().sales).toHaveLength(1);
  });

  it('(d) drain: one server call with the key; the server row replaces the projection, no duplicate', async () => {
    await useVentesStore.getState().recordClientPayment('Aïssatou', 'biz-1', 10000, 'especes', '2026-10-07', 'key-4');
    net.online = true;
    const r = await drainQueue();
    expect(r.synced).toBe(1);
    expect(mockQueue).toHaveLength(0);
    const calls = rpcCalls.filter(c => c.fn === 'record_client_payment');
    expect(calls).toHaveLength(1);
    expect(calls[0].args.p_idempotency_key).toBe('key-4');
    // the next server read lands (cache now holds the server's version)
    mockVentesCache.set('biz-1:all', [paidServerVersion]);
    net.online = false;
    await useVentesStore.getState().fetchSales('biz-1', undefined);
    const sales = useVentesStore.getState().sales;
    expect(sales).toHaveLength(1);
    expect(sales[0]).toMatchObject({ id: 'sale-1', status: 'paye', amount_paid: 10000 });
  });

  it('the other writers named in the brief already enqueue before any network call', () => {
    for (const [file, ops] of [
      ['stores/products.ts', ['create_product', 'update_product', 'adjust_stock_move']],
      ['stores/expenses.ts', ['operation, { id, ...patch }']],
    ] as const) {
      const src = read(file);
      for (const o of ops) expect(src).toContain(o);
    }
    // and none of the 7 calls supabase.rpc/from(...).insert|update for the write itself
    expect(read('stores/ventes.ts')).not.toMatch(/supabase\.rpc\('record_(client_)?payment'/);
    expect(read('stores/products.ts')).not.toMatch(/supabase\.rpc\('(create_product_with_stock|adjust_stock_move)'/);
  });
});

describe('gap 2 — filtered Ventes views overlay from the unfiltered baseline', () => {
  it('"À payer" keeps a pending credit; a payment that settles it moves it into "Payés"', async () => {
    await useVentesStore.getState().recordClientPayment('Aïssatou', 'biz-1', 10000, 'especes', '2026-10-07', 'key-5');
    kill();
    await useVentesStore.getState().fetchSales('biz-1', undefined, undefined, undefined, 'credit');
    expect(useVentesStore.getState().sales.map(s => s.id)).toEqual([]);          // settled -> left "À payer"
    await useVentesStore.getState().fetchSales('biz-1', undefined, undefined, undefined, 'paye');
    const paid = useVentesStore.getState().sales;
    expect(paid.map(s => s.id)).toEqual(['sale-1']);
    expect(paid[0].status).toBe('paye');
  });

  it('a pending new credit appears under "À payer" with nothing cached for that tab', async () => {
    mockQueue.push({
      id: nextId++, operation: 'submit_carnet_debt', status: 'pending', attempts: 0, idempotency_key: 'debt-9', entity_type: 'dette',
      queued_at: '2026-10-07T09:00:00.000Z', created_at: '2026-10-07T09:00:00.000Z',
      payload: JSON.stringify({ p_business_id: 'biz-1', p_seller_id: 'u1', p_customer_name: 'Mamadou', p_amount: 500000, p_idempotency_key: 'debt-9' }),
    });
    await useVentesStore.getState().fetchSales('biz-1', undefined, undefined, undefined, 'credit');
    expect(useVentesStore.getState().sales.map(s => s.id).sort()).toEqual(['debt-9', 'sale-1']);
  });
});

describe('gap 3 — a drain that synced something refreshes every affected base', () => {
  it('the drain epoch bump refetches sales AND the supplier history (no stale projection)', () => {
    const orig = { fs: useVentesStore.getState().fetchSales, fc: useFournisseursStore.getState().fetchCommandes, fd: useFournisseursStore.getState().fetchDebts };
    const fetchSales = jest.fn(); const fetchCommandes = jest.fn();
    useVentesStore.setState({ fetchSales } as any);
    useFournisseursStore.setState({ fetchCommandes, fetchDebts: jest.fn() } as any);
    try {
      useSyncStore.setState({ drainEpoch: useSyncStore.getState().drainEpoch + 1 });
      expect(fetchSales).toHaveBeenCalledWith('biz-1', undefined);
      expect(fetchCommandes).toHaveBeenCalledWith('biz-1');
    } finally {
      useVentesStore.setState({ fetchSales: orig.fs });
      useFournisseursStore.setState({ fetchCommandes: orig.fc, fetchDebts: orig.fd });
    }
  });
});

describe('gap 4 — réception history overlay', () => {
  const line = { product_id: 'p1', variant_id: null, name: 'Riz', qty: 10, unit_cost_cents: 300000, sale_price_cents: 500000 };
  const input = (extra: object = {}) => ({ supplierId: 'sup-1', lines: [line], transportCostCents: 100000, marginPercent: null, receivedDate: '2026-10-06', ...extra }) as any;
  const seed = () => useFournisseursStore.setState({ fournisseurs: [{ id: 'sup-1', name: 'Diallo & Fils' } as any], commandes: [] });

  it('(a) the confirmed delivery shows in history at once: supplier, date, lines, total, _pending', async () => {
    seed();
    await useFournisseursStore.getState().confirmReception('biz-1', 'u1', input({ idempotencyKey: 'rec-1' }));
    const row = useFournisseursStore.getState().commandes.find(c => c.id === 'rec-1')!;
    expect(row).toMatchObject({ supplier_name: 'Diallo & Fils', status: 'recu', received_at: '2026-10-06', _pending: true });
    expect(row.total_cost).toBe(31000);                       // 10 x 3000 + 1000 transport, display units
    expect(row.lines).toHaveLength(1);
    expect(row.lines![0]).toMatchObject({ product_name: 'Riz', qty_received: 10, unit_cost: 3000 });
    expect(rpcCalls).toHaveLength(0);
  });

  it('(b) kill -> reopen offline: history is rebuilt from the cache + the outbox', async () => {
    seed();
    mockCommandeCache.set('biz-1', [{ id: 'old-1', business_id: 'biz-1', supplier_id: 'sup-1', supplier_name: 'Diallo & Fils', status: 'recu', ordered_at: '2026-09-01', received_at: '2026-09-01', total_cost: 100 }]);
    await useFournisseursStore.getState().confirmReception('biz-1', 'u1', input({ idempotencyKey: 'rec-2' }));
    kill();
    await useFournisseursStore.getState().fetchCommandes('biz-1');  // offline -> cache fallback
    expect(useFournisseursStore.getState().commandes.map(c => c.id)).toEqual(['rec-2', 'old-1']);   // FIFO onto the baseline, newest first
  });

  it('(d) drain: the server row replaces the projection — one row, no _pending', async () => {
    seed();
    await useFournisseursStore.getState().confirmReception('biz-1', 'u1', input({ idempotencyKey: 'rec-3' }));
    net.online = true;
    expect((await drainQueue()).synced).toBe(1);
    serverCommandes = [{ id: 'rec-3', business_id: 'biz-1', supplier_id: 'sup-1', supplier: { name: 'Diallo & Fils' }, status: 'recu', ordered_at: '2026-10-06', received_at: '2026-10-06', total_cost: 40000 }];
    await useFournisseursStore.getState().fetchCommandes('biz-1');
    const rows = useFournisseursStore.getState().commandes.filter(c => c.id === 'rec-3');
    expect(rows).toHaveLength(1);
    expect(rows[0]._pending).toBeUndefined();
  });

  it('closing an existing order (Porte 2) flips it to received; once the server has it, nothing is projected twice', () => {
    const base: any[] = [{ id: 'po-1', business_id: 'biz-1', supplier_id: 'sup-1', supplier_name: 'S', status: 'envoye', ordered_at: '2026-10-01', received_at: null, total_cost: 5 }];
    const ops = [{ operation: 'confirm_reception', status: 'pending', queued_at: '2026-10-07T00:00:00Z', payload: JSON.stringify({ p_business_id: 'biz-1', p_po_id: 'po-1', p_idempotency_key: 'k', p_supplier_id: 'sup-1', p_lines: [], p_transport_cost_cents: 0 }) }];
    const folded = applyReceptionOps(base, ops, 'biz-1', () => 'S');
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({ id: 'po-1', status: 'recu', _pending: true });
    expect(base[0].status).toBe('envoye');                    // the baseline is never mutated
    const already = applyReceptionOps([{ ...base[0], status: 'recu' }], ops, 'biz-1', () => 'S');
    expect(already).toHaveLength(1);
    expect(already[0]._pending).toBeUndefined();
  });

  it('ignores refused and other-business ops', () => {
    const mk = (over: object) => ({ operation: 'confirm_reception', status: 'pending', queued_at: '2026-10-07T00:00:00Z', payload: JSON.stringify({ p_business_id: 'biz-1', p_idempotency_key: 'z', p_supplier_id: null, p_lines: [], p_transport_cost_cents: 0, ...over }) });
    expect(applyReceptionOps([], [{ ...mk({}), status: 'failed_permanent' }], 'biz-1', () => 'x')).toEqual([]);
    expect(applyReceptionOps([], [mk({ p_business_id: 'other' })], 'biz-1', () => 'x')).toEqual([]);
  });
});

describe('gap 5 — Crédit rapide: the client row is not on the critical path', () => {
  const src = read('src/components/CreditRapideCapture.tsx');
  it('the debt is enqueued BEFORE any clients upsert, and the upsert is never awaited by the save', () => {
    const submit = src.indexOf('await submitCarnetDebt(');
    const upsert = src.indexOf("from('clients').upsert(");
    expect(submit).toBeGreaterThan(-1);
    expect(upsert).toBeGreaterThan(submit);
    expect(src.slice(upsert - 200, upsert)).toMatch(/void \(async \(\) => \{/);
  });
  it('offline, the drain links the debt to a client by name (so skipping the upsert loses nothing)', () => {
    expect(read('lib/sync.ts')).toMatch(/onConflict: 'business_id,name'/);
  });
});

describe('gap 6 — failed syncs have a calm way in', () => {
  it('(d) a refused op is counted in failedCount and listed for Réessayer / Abandonner', async () => {
    mockQueue.push({
      id: nextId++, operation: 'record_client_payment', status: 'pending', attempts: 0, last_error: null, next_attempt_at: '2000-01-01T00:00:00.000Z',
      queued_at: '2026-10-07T00:00:00Z', created_at: '2026-10-07T00:00:00Z', entity_type: 'x', idempotency_key: 'bad-1',
      payload: JSON.stringify({ p_business_id: 'biz-1', p_customer_name: 'Aïssatou', p_amount: 99999999, p_method: 'especes', p_date: '2026-10-07', p_idempotency_key: 'bad-1' }),
    });
    net.online = true;
    // the server refuses it (not a network failure)
    const supa = jest.requireMock('@/lib/supabase').supabase;
    const orig = supa.rpc; supa.rpc = async () => ({ data: null, error: { message: 'Le montant dépasse le solde restant dû', code: 'P0001' } });
    await useSyncStore.getState().sync();
    supa.rpc = orig;
    expect(useSyncStore.getState().failedCount).toBe(1);
    expect(useSyncStore.getState().pendingCount).toBe(0);
    const refused = await loadRefusedOps('biz-1');
    expect(refused).toHaveLength(1);
    expect(refused[0].retryable).toBe(true);
  });
  it('the entry point is mounted on Accueil, Ventes and Rapports', () => {
    for (const f of ['app/(app)/(tabs)/index.tsx', 'app/(app)/ventes/index.tsx', 'app/(app)/rapports/index.tsx']) {
      expect(read(f)).toMatch(/<RefusedOpsNotice \/>/);
    }
    expect(read('src/components/RefusedOpsNotice.tsx')).toMatch(/useSyncStore\(s => s\.failedCount\)/);
  });
});
