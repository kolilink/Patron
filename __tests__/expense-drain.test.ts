// The outbox replays expense ops idempotently: a create whose first attempt
// already landed (23505) is success, delete/restore go through the soft-delete
// RPCs (migration_v234), and none of it can double-record.
const mockQueue: any[] = [];
const calls: { fn: string; args: any }[] = [];
let insertError: any = null;
let rpcError: any = null;

jest.mock('@/lib/db', () => ({
  ...jest.requireActual('@/lib/db'),
  getPendingOpsForDrain: async () => ({ ok: mockQueue.filter(q => q.status === 'pending').map(q => ({ ...q })), corrupt: [] }),
  deleteQueueItem: async (id: number) => { const i = mockQueue.findIndex(q => q.id === id); if (i >= 0) mockQueue.splice(i, 1); },
  rescheduleOp: async () => {},
  markOpPermanentlyFailed: async (id: number) => { const q = mockQueue.find(x => x.id === id); if (q) q.status = 'failed_permanent'; },
  markOpCorrupt: async () => {},
}));
jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: (t: string) => ({
      insert: async (payload: any) => { calls.push({ fn: `insert:${t}`, args: payload }); return { error: insertError }; },
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { currency: 'GNF' } }) }) }),
    }),
    rpc: async (fn: string, args: any) => { calls.push({ fn, args }); return { error: rpcError }; },
    auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })) },
  },
}));
jest.mock('@/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/lib/posthog', () => ({ posthog: null }));
jest.mock('@/src/utils/notifications', () => ({ notifyEvent: jest.fn(), resolveSellerDisplayName: jest.fn() }));

import { drainQueue } from '@/lib/sync';

const push = (operation: string, payload: any) =>
  mockQueue.push({ id: mockQueue.length + 1, operation, payload: JSON.stringify(payload), status: 'pending', attempts: 0 });

beforeEach(() => { mockQueue.length = 0; calls.length = 0; insertError = null; rpcError = null; });

describe('expense ops drain', () => {
  it('delete/restore replay through the soft-delete RPCs', async () => {
    push('delete_expense', { p_expense_id: 'e1' });
    push('restore_expense', { p_expense_id: 'e1' });
    const r = await drainQueue();
    expect(r.synced).toBe(2);
    expect(calls.map(c => c.fn)).toEqual(['soft_delete_expense', 'restore_expense']);
    expect(mockQueue).toEqual([]);
  });

  it('a create that already landed (23505) is success, not a refusal', async () => {
    insertError = { code: '23505', message: 'duplicate key value violates unique constraint' };
    push('create_expense', { id: 'e1', business_id: 'b', amount: 100, description: 'x', status: 'approuve' });
    const r = await drainQueue();
    expect(r.synced).toBe(1);
    expect(mockQueue).toEqual([]);
  });

  it('any other insert error is still a failure (kept for retry/refusal)', async () => {
    insertError = { code: 'P0001', message: 'Refusé' };
    push('create_expense', { id: 'e1', business_id: 'b', amount: 100, description: 'x', status: 'approuve' });
    const r = await drainQueue();
    expect(r.synced).toBe(0);
    expect(mockQueue).toHaveLength(1);
  });
  it('approve/reject replay through decide_expense, never a blind UPDATE', async () => {
    const d = { id: 'e1', approved_by: 'u1', approved_at: new Date().toISOString() };
    push('approve_expense', { ...d, status: 'approuve' });
    push('reject_expense', { ...d, status: 'rejete' });
    const r = await drainQueue();
    expect(r.synced).toBe(2);
    expect(calls.filter(c => c.fn === 'decide_expense').map(c => c.args)).toEqual([
      { p_expense_id: 'e1', p_status: 'approuve' },
      { p_expense_id: 'e1', p_status: 'rejete' },
    ]);
  });

  it('a refused decision (P0001) is a permanent refusal that stays visible, not a silent overwrite', async () => {
    rpcError = { code: 'P0001', message: 'Cette dépense a déjà été approuvée par Awa.' };
    push('reject_expense', { id: 'e1', status: 'rejete', approved_by: 'u1', approved_at: new Date().toISOString() });
    const r = await drainQueue();
    expect(r.synced).toBe(0);
    expect(r.failed).toBe(1);
    expect(mockQueue[0].status).toBe('failed_permanent');
  });
});
