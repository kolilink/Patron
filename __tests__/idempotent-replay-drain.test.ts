// Every mutating op must be safe to replay. create_product: a 23505 (the id
// already landed, only the response was lost) is success. adjust_stock_move:
// replay-safe by construction on the server (p_move_id is the stock_moves PK,
// ON CONFLICT DO NOTHING — migration_v243, live in production); here we prove
// the client side: it drains, resolves, and the row clears (no infinite retry).
const mockQueue: any[] = [];
const calls: { fn: string; args: any }[] = [];
let rpcError: any = null;

jest.mock('@/lib/db', () => ({
  ...jest.requireActual('@/lib/db'),
  getPendingOpsForDrain: async () => ({ ok: mockQueue.filter(q => q.status === 'pending').map(q => ({ ...q })), corrupt: [] }),
  deleteQueueItem: async (id: number) => { const i = mockQueue.findIndex(q => q.id === id); if (i >= 0) mockQueue.splice(i, 1); },
  rescheduleOp: async (id: number) => { const q = mockQueue.find(x => x.id === id); if (q) q.attempts++; },
  markOpPermanentlyFailed: async (id: number) => { const q = mockQueue.find(x => x.id === id); if (q) q.status = 'failed_permanent'; },
  markOpCorrupt: async () => {},
}));
jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: async (fn: string, args: any) => { calls.push({ fn, args }); return { data: null, error: rpcError }; },
    from: () => ({}),
    auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })) },
  },
}));
jest.mock('@/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/lib/posthog', () => ({ posthog: null }));
jest.mock('@/src/utils/notifications', () => ({ notifyEvent: jest.fn(), resolveSellerDisplayName: jest.fn() }));

import { drainQueue } from '@/lib/sync';

const push = (operation: string, payload: any) =>
  mockQueue.push({ id: mockQueue.length + 1, operation, payload: JSON.stringify(payload), status: 'pending', attempts: 0 });
beforeEach(() => { mockQueue.length = 0; calls.length = 0; rpcError = null; });

const product = { id: 'p1', business_id: 'b', name: 'Riz' };

describe('create_product replay', () => {
  it('first send succeeds and clears the row', async () => {
    push('create_product', { product, stockMove: null });
    expect((await drainQueue()).synced).toBe(1);
    expect(mockQueue).toEqual([]);
  });
  it('a replay answered with 23505 is success, not a refusal or a retry loop', async () => {
    rpcError = { code: '23505', message: 'duplicate key value violates unique constraint "products_pkey"' };
    push('create_product', { product, stockMove: null });
    const r = await drainQueue();
    expect(r.synced).toBe(1);
    expect(mockQueue).toEqual([]);
  });
  it('any other error is still a failure', async () => {
    rpcError = { code: 'P0001', message: 'Refusé' };
    push('create_product', { product, stockMove: null });
    expect((await drainQueue()).synced).toBe(0);
    expect(mockQueue).toHaveLength(1);
  });
});

describe('adjust_stock_move drain', () => {
  const args = { p_business_id: 'b', p_product_id: 'p1', p_type: 'perte', p_qty: 3, p_note: null, p_move_id: 'm1' };
  it('drains, calls the RPC once with the move id, and the row clears', async () => {
    push('adjust_stock_move', args);
    const r = await drainQueue();
    expect(r.synced).toBe(1);
    expect(calls).toEqual([{ fn: 'adjust_stock_move', args }]);
    expect(mockQueue).toEqual([]);
    expect((await drainQueue()).synced).toBe(0);     // nothing left to retry
    expect(calls).toHaveLength(1);
  });
  it('a server refusal parks the row (failed_permanent) instead of retrying forever', async () => {
    rpcError = { code: 'P0001', message: 'Produit introuvable' };
    push('adjust_stock_move', args);
    await drainQueue();
    expect(mockQueue[0].status).toBe('failed_permanent');
    await drainQueue();
    expect(calls).toHaveLength(1);
  });
});
