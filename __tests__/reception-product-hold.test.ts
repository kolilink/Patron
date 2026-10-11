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
      entity_type: operation === 'create_product' ? 'produit' : 'reception', idempotency_key: payload.p_idempotency_key ?? null,
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

const PID = '11111111-1111-4111-8111-111111111111';
const createProductPayload = () => ({
  product: { id: PID, business_id: 'biz-1', name: 'Savon', unit: 'pcs', cost_price: 0, sale_price: 150000, stock_qty: 0, reorder_level: 0, archived: false },
  stockMove: null,
});
const receptionPayload = (productId: string | null = PID) => ({
  p_business_id: 'biz-1', p_supplier_id: null, p_po_id: null,
  p_lines: [{ product_id: productId, variant_id: null, name: 'Savon', qty: 12, unit_cost_cents: 90000, sale_price_cents: 150000 }],
  p_transport_cost_cents: 0, p_margin_percent: null, p_received_date: null, p_idempotency_key: 'rec-1',
});

beforeEach(() => { mockQueue.length = 0; mockNextId = 1; rpcCalls.length = 0; rpcError = null; failOnlyFn = null; });

describe('a delivery waits for the product it books stock onto', () => {
  it('create_product then confirm_reception drain in order in one pass (FIFO) when the create succeeds', async () => {
    await enqueue('create_product', createProductPayload());
    await enqueue('confirm_reception', receptionPayload());
    const r = await drainQueue();
    expect(r.synced).toBe(2);
    expect(mockQueue).toHaveLength(0);
    const order = rpcCalls.map(c => c.fn).filter(f => f !== 'log_sync_lag');
    expect(order.indexOf('create_product_with_stock')).toBeLessThan(order.indexOf('confirm_reception'));
  });

  it('HOLDS the delivery when the product create is still queued after a non-network failure (no dangling product)', async () => {
    await enqueue('create_product', createProductPayload());
    await enqueue('confirm_reception', receptionPayload());
    // The create fails with a 5xx-shaped error: it reschedules AND the pass continues — the FIFO hole.
    rpcError = { code: '500', message: 'Internal Server Error' };
    failOnlyFn = 'create_product_with_stock';
    const r = await drainQueue();
    expect(r.synced).toBe(0);
    expect(rpcCalls.map(c => c.fn)).toEqual(['create_product_with_stock']); // the delivery never reached the server
    const rec = mockQueue.find(q => q.operation === 'confirm_reception')!;
    expect(rec.status).toBe('pending');
    expect(rec.attempts).toBe(1);
    expect(rec.last_error).toMatch(/Création du produit encore en attente/);
  });

  it('a delivery for an existing (server) product is not held by an unrelated pending create', async () => {
    await enqueue('create_product', createProductPayload());
    await enqueue('confirm_reception', receptionPayload('22222222-2222-4222-8222-222222222222'));
    rpcError = { code: '500', message: 'Internal Server Error' };
    failOnlyFn = 'create_product_with_stock';
    await drainQueue();
    expect(rpcCalls.map(c => c.fn)).toContain('confirm_reception');
  });

  it('once the create has landed, the held delivery goes through on the next pass', async () => {
    await enqueue('create_product', createProductPayload());
    await enqueue('confirm_reception', receptionPayload());
    rpcError = { code: '500', message: 'Internal Server Error' };
    failOnlyFn = 'create_product_with_stock';
    await drainQueue();
    // reconnect: create succeeds now; make the held ops due again
    rpcError = null; failOnlyFn = null; rpcCalls.length = 0;
    mockQueue.forEach(q => { q.next_attempt_at = '2000-01-01T00:00:00.000Z'; });
    const r = await drainQueue();
    expect(r.synced).toBe(2);
    expect(mockQueue).toHaveLength(0);
    const order = rpcCalls.map(c => c.fn).filter(f => f !== 'log_sync_lag');
    expect(order.indexOf('create_product_with_stock')).toBeLessThan(order.indexOf('confirm_reception'));
  });

  it('lib/db.ts reads the pending product ids from the decrypted create_product payloads (covers rows queued by older builds)', () => {
    const fs = require('fs'); const path = require('path');
    const db = fs.readFileSync(path.resolve(__dirname, '..', 'lib/db.ts'), 'utf8');
    const fn = db.slice(db.indexOf('export async function getPendingProductKeys'), db.indexOf('// ─── Shared encrypted-cache writer'));
    expect(fn).toContain("operation = 'create_product'");
    expect(fn).toContain('await decrypt(row.payload)');
    expect(fn).toContain('.product?.id');
  });
});
