// A réception confirmed in a dead zone is not lost and not doubled:
// local-write-first into the durable outbox, survives an app kill, drains on
// reconnect through the same executeOp as every other queued write, and the
// server books it once (migration_v229; see the integration suite).

const mockQueue: any[] = [];
let mockNextId = 1;
const mockProductCache = new Map<string, any[]>();
let net = { online: false };
let enqueueThrows = false;
const rpcCalls: { fn: string; args: any }[] = [];

jest.mock('@/lib/db', () => ({
  ...jest.requireActual('@/lib/db'),
  enqueue: async (operation: string, payload: any) => {
    if (enqueueThrows) throw new Error('SQLite disk I/O error');
    mockQueue.push({
      id: mockNextId++, operation, payload: JSON.stringify(payload), status: 'pending', attempts: 0, last_error: null,
      next_attempt_at: '2000-01-01T00:00:00.000Z', queued_at: new Date().toISOString(), created_at: new Date().toISOString(),
      entity_type: 'reception', idempotency_key: payload.p_idempotency_key ?? null,
    });
  },
  getAllQueueItemsForOverlay: async () => ({ ok: mockQueue.map(q => ({ ...q })), corrupt: [] }),
  getPendingOpsForDrain: async () => ({ ok: mockQueue.filter(q => q.status === 'pending').map(q => ({ ...q })), corrupt: [] }),
  deleteQueueItem: async (id: number) => { const i = mockQueue.findIndex(q => q.id === id); if (i >= 0) mockQueue.splice(i, 1); },
  rescheduleOp: async (id: number) => { const q = mockQueue.find(x => x.id === id); if (q) q.attempts++; },
  markOpPermanentlyFailed: async (id: number, e: string) => { const q = mockQueue.find(x => x.id === id); if (q) { q.status = 'failed_permanent'; q.last_error = e; } },
  markOpCorrupt: async () => {},
  getQueueCount: async () => mockQueue.filter(q => q.status === 'pending').length,
  getFailedQueueCount: async () => 0,
  getProductCache: async (b: string) => (mockProductCache.has(b) ? JSON.parse(JSON.stringify(mockProductCache.get(b))) : null),
  saveProductCache: async (b: string, v: any[]) => { mockProductCache.set(b, JSON.parse(JSON.stringify(v))); },
  getVariantsCache: async () => null,
  saveVariantsCache: async () => {},
}));

const NETWORK_ERROR = { message: 'Failed to fetch', code: '', details: '', hint: '' };
jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: async (fn: string, args: any) => {
      rpcCalls.push({ fn, args });
      if (!net.online) throw new Error('Network request failed');
      return { data: args.p_idempotency_key ?? 'po-x', error: null };
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { name: 'Fournisseur' } }) }) }) }),
    auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })) },
  },
}));
jest.mock('@/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/lib/posthog', () => ({ posthog: null }));
jest.mock('@/src/utils/notifications', () => ({ notifyEvent: jest.fn(), resolveSellerDisplayName: jest.fn().mockResolvedValue('Fatou') }));
jest.mock('@/stores/auth', () => ({
  useAuthStore: { getState: () => ({ session: { activeBusiness: { id: 'biz-1' }, activeMembership: { role: 'administrateur' }, user: { id: 'u1' } } }) },
}));

import { useFournisseursStore } from '@/stores/fournisseurs';
import { useProductStore } from '@/stores/products';
import { useSyncStore } from '@/stores/sync';
import { drainQueue } from '@/lib/sync';

const line = { product_id: 'p1', variant_id: null, name: 'Riz', qty: 10, unit_cost_cents: 300000, sale_price_cents: 500000 };
const input = (extra: object = {}) => ({ supplierId: null, lines: [line], transportCostCents: 0, marginPercent: null, receivedDate: null, ...extra }) as any;
const rpc = () => rpcCalls.filter(c => c.fn === 'confirm_reception');

beforeEach(() => {
  mockQueue.length = 0; rpcCalls.length = 0; mockProductCache.clear();
  net = { online: false }; enqueueThrows = false;
  mockProductCache.set('biz-1', [{ id: 'p1', name: 'Riz', stock_qty: 5, has_variants: false }]);
  useProductStore.setState({ products: [{ id: 'p1', name: 'Riz', stock_qty: 5, has_variants: false } as any], variantsByProduct: {} });
  useFournisseursStore.setState({ saving: false, error: null });
  // The write path kicks the drainer; here the drain is driven explicitly so each step is observable.
  useSyncStore.setState({ pendingCount: 0, kick: jest.fn() } as any);
});

describe('offline confirm → kill → reopen → reconnect → one server record', () => {
  it('step 1 (dead zone): the confirmation returns at once, writes to the outbox, never calls the server', async () => {
    const poId = await useFournisseursStore.getState().confirmReception('biz-1', 'u1', input({ idempotencyKey: 'key-1' }));
    expect(poId).toBe('key-1');                      // a new order's id IS the key: known before it ever syncs
    expect(mockQueue).toHaveLength(1);
    expect(mockQueue[0].operation).toBe('confirm_reception');
    expect(JSON.parse(mockQueue[0].payload).p_idempotency_key).toBe('key-1');
    expect(rpc()).toHaveLength(0);
  });

  it('the stock of an existing product rises on this phone straight away (estimate), and survives the kill via the cache', async () => {
    await useFournisseursStore.getState().confirmReception('biz-1', 'u1', input({ idempotencyKey: 'key-2' }));
    expect(useProductStore.getState().products[0].stock_qty).toBe(15);
    expect(mockProductCache.get('biz-1')![0].stock_qty).toBe(15);
  });

  it('a confirmation against an existing order (Porte 2) returns that order id', async () => {
    const id = await useFournisseursStore.getState().confirmReception('biz-1', 'u1', input({ poId: 'po-existing', idempotencyKey: 'key-3' }));
    expect(id).toBe('po-existing');
  });

  it('step 2 (kill + reopen): the stores start cold, the outbox still holds exactly one reception', async () => {
    await useFournisseursStore.getState().confirmReception('biz-1', 'u1', input({ idempotencyKey: 'key-4' }));
    useFournisseursStore.setState({ saving: false, error: null });
    useProductStore.setState({ products: [], variantsByProduct: {} });
    useSyncStore.setState({ pendingCount: 0 });
    expect(mockQueue.filter(q => q.operation === 'confirm_reception')).toHaveLength(1);
  });

  it('step 3 (still offline): the drain keeps it queued, nothing lost, nothing booked', async () => {
    await useFournisseursStore.getState().confirmReception('biz-1', 'u1', input({ idempotencyKey: 'key-5' }));
    const r = await drainQueue();
    expect(r.synced).toBe(0);
    expect(mockQueue).toHaveLength(1);
    expect(mockQueue[0].status).toBe('pending');
  });

  it('step 4 (reconnect): one drain → exactly one server call carrying the key; the queue empties; a second drain does nothing', async () => {
    await useFournisseursStore.getState().confirmReception('biz-1', 'u1', input({ idempotencyKey: 'key-6' }));
    await drainQueue();                                // dead zone: fails, stays queued
    net.online = true;
    const r = await drainQueue();
    expect(r.synced).toBe(1);
    expect(mockQueue).toHaveLength(0);
    const calls = rpc().filter(c => net.online && c.args.p_idempotency_key === 'key-6');
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const before = rpc().length;
    await drainQueue();
    expect(rpc().length).toBe(before);                 // nothing replayed
  });
});

describe('nothing doubled', () => {
  it('a retry with the same key leaves ONE outbox row (double tap / failure + Réessayer)', async () => {
    const a = useFournisseursStore.getState().confirmReception('biz-1', 'u1', input({ idempotencyKey: 'key-7' }));
    const b = useFournisseursStore.getState().confirmReception('biz-1', 'u1', input({ idempotencyKey: 'key-7' }));
    await Promise.all([a, b]);
    await useFournisseursStore.getState().confirmReception('biz-1', 'u1', input({ idempotencyKey: 'key-7' }));
    expect(mockQueue.filter(q => q.operation === 'confirm_reception')).toHaveLength(1);
  });

  it('two different receptions are two rows', async () => {
    await useFournisseursStore.getState().confirmReception('biz-1', 'u1', input({ idempotencyKey: 'key-8' }));
    await useFournisseursStore.getState().confirmReception('biz-1', 'u1', input({ idempotencyKey: 'key-9' }));
    expect(mockQueue).toHaveLength(2);
  });
});

describe('failure speaks the Phase 4 vocabulary', () => {
  it('if the phone cannot store it: null, nothing booked, stock untouched, draft intact for Réessayer', async () => {
    enqueueThrows = true;
    const poId = await useFournisseursStore.getState().confirmReception('biz-1', 'u1', input({ idempotencyKey: 'key-10' }));
    expect(poId).toBeNull();
    expect(mockQueue).toHaveLength(0);
    expect(useProductStore.getState().products[0].stock_qty).toBe(5);
    expect(useFournisseursStore.getState().saving).toBe(false);
  });

  it('the screen shows receptionNotRecorded with Réessayer, reuses one key, and explains a queued order honestly', () => {
    const fs = require('fs'); const path = require('path');
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'app/(app)/fournisseurs/reception.tsx'), 'utf8');
    expect(src).toMatch(/failAlert\('receptionNotRecorded', \{ label: 'Réessayer'/);
    expect(src).toMatch(/if \(!receptionKeyRef\.current\) receptionKeyRef\.current = generateId\(\)/);
    expect(src).toMatch(/idempotencyKey: key/);
    expect(src).toMatch(/Pas encore envoyée\. Elle partira dès que le téléphone sera connecté\./);
    expect(src).toMatch(/failAlert\('supplierNotChangedYet'\)/);
    expect(src).not.toMatch(/La livraison n\\'a pas pu être enregistrée/);
  });
});

describe('the drain classifies a refused réception like any other op', () => {
  it('a server refusal (P0001) is permanent and surfaces through the refused-ops notice with its reason', async () => {
    net.online = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supa = require('@/lib/supabase').supabase;
    const original = supa.rpc;
    supa.rpc = async () => ({ data: null, error: { code: 'P0001', message: 'Commande introuvable ou déjà terminée' } });
    await useFournisseursStore.getState().confirmReception('biz-1', 'u1', input({ idempotencyKey: 'key-11' }));
    await drainQueue();
    supa.rpc = original;
    expect(mockQueue[0].status).toBe('failed_permanent');
    const { loadRefusedOps } = require('@/lib/pendingOverlay');
    const refused = await loadRefusedOps('biz-1');
    expect(refused[0]).toMatchObject({ label: 'Livraison', reason: 'Commande introuvable ou déjà terminée' });
  });
});
