// Offline ordering: a delivery that books stock onto a product still waiting in the outbox must not
// drain before that product exists server-side — the same guarantee pending suppliers have.

const mockQueue: any[] = [];
let mockNextId = 1;
let rpcError: any = null;
let failOnlyFn: string | null = null;
const rpcCalls: { fn: string; args: any }[] = [];

jest.mock('@/lib/connectivity', () => ({ isKnownOffline: () => false }));
jest.mock('@/lib/db', () => ({
  enqueue: async (operation: string, payload: any) => {
    mockQueue.push({
      id: mockNextId++, operation, payload: JSON.stringify(payload), status: 'pending', attempts: 0, last_error: null,
      next_attempt_at: '2000-01-01T00:00:00.000Z', queued_at: new Date().toISOString(), created_at: new Date().toISOString(),
      entity_type: operation === 'create_product' ? 'produit' : 'fournisseur', idempotency_key: payload.p_idempotency_key ?? null,
    });
  },
  getPendingOpsForDrain: async () => ({
    ok: mockQueue.filter(q => q.status === 'pending' && (!q.next_attempt_at || q.next_attempt_at <= new Date().toISOString())).map(q => ({ ...q })),
    corrupt: [],
  }),
  deleteQueueItem: async (id: number) => { const i = mockQueue.findIndex(q => q.id === id); if (i >= 0) mockQueue.splice(i, 1); },
  rescheduleOp: async (id: number, nextAttemptAt: string, error: string) => {
    const q = mockQueue.find(x => x.id === id);
    if (q) { q.attempts++; q.next_attempt_at = nextAttemptAt; q.last_error = error; }
  },
  markOpPermanentlyFailed: async (id: number, e: string) => { const q = mockQueue.find(x => x.id === id); if (q) { q.status = 'failed_permanent'; q.last_error = e; } },
  markOpCorrupt: async (id: number, e: string) => { const q = mockQueue.find(x => x.id === id); if (q) { q.status = 'failed_corrupt'; q.last_error = e; } },
  getPendingSupplierKeys: async () => new Set<string>(),
  // Same contract as lib/db.ts: ids of pending create_product ops.
  getPendingProductKeys: async () => new Set(
    mockQueue.filter(q => q.status === 'pending' && q.operation === 'create_product').map(q => JSON.parse(q.payload).product.id),
  ),
  getQueueCount: async () => mockQueue.filter(q => q.status === 'pending').length,
}));
jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: async (fn: string, args: any) => {
      rpcCalls.push({ fn, args });
      return { data: null, error: failOnlyFn && fn !== failOnlyFn ? null : rpcError };
    },
    from: () => ({
      insert: async () => { rpcCalls.push({ fn: 'insert:products', args: null }); return { data: null, error: failOnlyFn === 'create_product' ? rpcError : null }; },
      update: () => ({ eq: async () => ({ data: null, error: null }) }),
    }),
    auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })) },
  },
}));
jest.mock('@/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/lib/posthog', () => ({ posthog: null }));
jest.mock('@/src/utils/notifications', () => ({ notifyEvent: jest.fn(), resolveSellerDisplayName: jest.fn() }));
jest.mock('@/stores/auth', () => ({
  useAuthStore: { getState: () => ({ session: { activeBusiness: { id: 'biz-1' }, activeMembership: { role: 'administrateur' }, user: { id: 'u1' } } }) },
}));

import { drainQueue } from '@/lib/sync';
import { enqueue } from '@/lib/db';
import * as fs from 'fs';
import * as path from 'path';

const PID = '11111111-1111-4111-8111-111111111111';
const SID = '33333333-3333-4333-8333-333333333333';
const createProductPayload = () => ({
  product: { id: PID, business_id: 'biz-1', name: 'Riz 5kg', unit: 'pcs', cost_price: 0, sale_price: 850000, stock_qty: 0, reorder_level: 0, archived: false },
  stockMove: null,
});
const supplierPayload = (links: string[], newProducts: unknown[] = []) => ({
  p_supplier: { id: SID, business_id: 'biz-1', name: 'Diallo Import', phone: null, country: null, notes: null, lead_days: null, created_by: 'u1' },
  p_new_products: newProducts, p_link_product_ids: links, p_unlink_product_ids: [],
});

beforeEach(() => { mockQueue.length = 0; mockNextId = 1; rpcCalls.length = 0; rpcError = null; failOnlyFn = null; });

describe('supplier form: inline product creation is gone', () => {
  const form = fs.readFileSync(path.join(__dirname, '..', 'app/(app)/fournisseurs/index.tsx'), 'utf8');
  const formSrc = form.slice(form.indexOf('function FournisseurForm'), form.indexOf('// ─── Success Sheet'));
  it.each(['temp_', 'newProductName', 'showCreate', 'confirmNew', 'localProducts', 'newProducts'])('no %s in the form', token => {
    expect(formSrc).not.toContain(token);
  });
  it('opens the one flow: "+ Nouveau produit" → QuickAddProductSheet with the supplier context', () => {
    expect(formSrc).toContain('+ Nouveau produit');
    expect(formSrc).toContain('<QuickAddProductSheet');
    expect(formSrc).toContain('supplierId={sheetSupplierId}');
    // the new product's client UUID joins linkedIds
    expect(formSrc).toMatch(/generateId\(\)[\s\S]*setLinkedIds\(prev => new Set\(\[\.\.\.prev, productId\]\)\)/);
  });
  it('the store no longer builds p_new_products from a draft', () => {
    const store = fs.readFileSync(path.join(__dirname, '..', 'stores/fournisseurs.ts'), 'utf8');
    expect(store).not.toContain('newProducts');
  });
});

describe('a supplier save waits for the product the sheet created', () => {
  it('create_product then create_supplier drain in order and the supplier links the new UUID', async () => {
    await enqueue('create_product', createProductPayload());
    await enqueue('create_supplier', supplierPayload([PID]));
    const r = await drainQueue();
    expect(r.synced).toBe(2);
    const calls = rpcCalls.filter(c => c.fn !== 'log_sync_lag');
    expect(calls.map(c => c.fn)).toEqual(['create_product_with_stock', 'upsert_supplier']);
    expect(calls[1].args.p_link_product_ids).toEqual([PID]);
    expect(calls[1].args.p_new_products).toEqual([]);
  });

  it('HOLDS the supplier save while the product create is still queued after a transient failure', async () => {
    await enqueue('create_product', createProductPayload());
    await enqueue('create_supplier', supplierPayload([PID]));
    rpcError = { code: '500', message: 'Internal Server Error' };
    failOnlyFn = 'create_product_with_stock';
    const r = await drainQueue();
    expect(r.synced).toBe(0);
    expect(rpcCalls.map(c => c.fn)).toEqual(['create_product_with_stock']);
    const sup = mockQueue.find(q => q.operation === 'create_supplier')!;
    expect(sup.status).toBe('pending');
    expect(sup.last_error).toMatch(/Création du produit encore en attente/);
  });

  it('an update_supplier linking only server products is not held by an unrelated pending create', async () => {
    await enqueue('create_product', createProductPayload());
    await enqueue('update_supplier', supplierPayload(['22222222-2222-4222-8222-222222222222']));
    rpcError = { code: '500', message: 'Internal Server Error' };
    failOnlyFn = 'create_product_with_stock';
    await drainQueue();
    expect(rpcCalls.map(c => c.fn)).toContain('upsert_supplier');
  });
});

describe('already-queued payloads (pre-change app versions) still replay', () => {
  it('a queued create_supplier carrying p_new_products drains through the kept path unchanged', async () => {
    const np = [{ id: '44444444-4444-4444-8444-444444444444', name: 'Savon', unit: 'pcs' }];
    await enqueue('create_supplier', supplierPayload([], np));
    const r = await drainQueue();
    expect(r.synced).toBe(1);
    const call = rpcCalls.find(c => c.fn === 'upsert_supplier')!;
    expect(call.args.p_new_products).toEqual(np);
  });
});
