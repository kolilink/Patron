// Expense mutations are local-write-first through the outbox. Pins: create →
// Annuler cancels the queued create (same path as delete); undo of that delete
// re-queues the create; a synced row's delete queues a soft delete and its undo
// cancels it; edits of an unsynced row rewrite its queued create; and the month
// total always equals the sum of the rows shown.
const mockQueue: any[] = [];
let mockNextId = 1;

jest.mock('@/lib/db', () => ({
  ...jest.requireActual('@/lib/db'),
  enqueue: async (operation: string, payload: any) => {
    const p = payload as any;
    mockQueue.push({
      id: mockNextId++, operation, payload: JSON.stringify(payload), status: 'pending', attempts: 0, last_error: null,
      entity_type: 'depense', idempotency_key: p.p_idempotency_key ?? p.id ?? p.p_expense_id ?? null,
    });
  },
  cancelPendingQueueItems: async (ops: string[], key: string) => {
    let n = 0;
    for (let i = mockQueue.length - 1; i >= 0; i--) {
      const q = mockQueue[i];
      if (q.status === 'pending' && q.idempotency_key === key && ops.includes(q.operation)) { mockQueue.splice(i, 1); n++; }
    }
    return n;
  },
  getAllQueueItemsForOverlay: async () => ({ ok: mockQueue.map(q => ({ ...q })), corrupt: [] }),
  getQueueCount: async () => mockQueue.filter(q => q.status === 'pending').length,
  getFailedQueueCount: async () => 0,
  saveExpenseCache: async () => {},
  getExpenseCache: async () => null,
  getCacheTimestamp: async () => null,
}));
jest.mock('@/lib/supabase', () => ({ supabase: { from: jest.fn(), rpc: jest.fn(), auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })) } } }));
jest.mock('@/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/lib/posthog', () => ({ posthog: null }));
jest.mock('@/src/utils/notifications', () => ({ notifyEvent: jest.fn(), resolveSellerDisplayName: jest.fn() }));
jest.mock('@/stores/auth', () => ({
  useAuthStore: { getState: () => ({ session: { activeBusiness: { id: 'biz-1', currency: 'GNF' }, activeMembership: { role: 'administrateur' }, user: { id: 'u1', name: 'Fatou' } } }) },
}));
jest.mock('@/stores/products', () => ({
  useProductStore: { getState: () => ({ products: [{ id: 'p1', name: 'Riz 50 kg' }, { id: 'p2', name: 'Huile' }] }) },
}));

import { useExpensesStore } from '@/stores/expenses';
import { useSyncStore } from '@/stores/sync';
import { sumApproved } from '@/src/utils/expenseUtils';

const data = (amount: number, product_id: string | null = null) => ({ amount, description: 'Dépense', category: null, date: '2026-10-05', due_date: null, note: null, product_id });
const ops = () => mockQueue.map(q => q.operation);
const total = () => sumApproved(useExpensesStore.getState().expenses);

beforeEach(() => {
  mockQueue.length = 0;
  useExpensesStore.getState().reset();
  useSyncStore.setState({ syncing: false, kick: jest.fn() } as any);
});

describe('expense store — local-write-first', () => {
  it('create shows the row instantly with its product and queues exactly one create', async () => {
    const id = await useExpensesStore.getState().createExpense('biz-1', 'u1', data(25000, 'p1'), true);
    expect(id).toBeTruthy();
    expect(ops()).toEqual(['create_expense']);
    expect(useExpensesStore.getState().expenses[0]).toMatchObject({ id, amount: 25000, product_name: 'Riz 50 kg' });
    expect(total()).toBe(25000);
  });

  it('Annuler on an unsynced create cancels the queued op (no create+delete pair)', async () => {
    const s = useExpensesStore.getState();
    const id = (await s.createExpense('biz-1', 'u1', data(25000, 'p1'), true))!;
    await s.deleteExpense(id, 'biz-1');
    expect(ops()).toEqual([]);
    expect(useExpensesStore.getState().expenses).toEqual([]);
    expect(total()).toBe(0);
    // undo of that delete queues the create again
    await s.restoreExpense(id, 'biz-1');
    expect(ops()).toEqual(['create_expense']);
    expect(useExpensesStore.getState().expenses.map(e => e.id)).toEqual([id]);
    expect(total()).toBe(25000);
  });

  it('while a drain is in flight Annuler queues a delete instead of racing it', async () => {
    const s = useExpensesStore.getState();
    const id = (await s.createExpense('biz-1', 'u1', data(1000), true))!;
    useSyncStore.setState({ syncing: true } as any);
    await s.deleteExpense(id, 'biz-1');
    expect(ops()).toEqual(['create_expense', 'delete_expense']);
    expect(useExpensesStore.getState().expenses).toEqual([]);
  });

  it('edit of an unsynced row rewrites its queued create (one row to send)', async () => {
    const s = useExpensesStore.getState();
    const id = (await s.createExpense('biz-1', 'u1', data(1000, 'p1'), true))!;
    await s.updateExpense(id, 'biz-1', data(2000, 'p2'));
    expect(ops()).toEqual(['create_expense']);
    expect(JSON.parse(mockQueue[0].payload)).toMatchObject({ id, amount: 200000, product_id: 'p2' });
    expect(useExpensesStore.getState().expenses[0]).toMatchObject({ amount: 2000, product_name: 'Huile' });
  });

  it('a synced row: delete queues a soft delete, its undo cancels that op', async () => {
    const synced: any = { id: 'srv-1', business_id: 'biz-1', amount: 5000, description: 'x', category: null, date: '2026-10-05', due_date: null, note: null, status: 'approuve', created_by: 'u1', created_at: 'a', updated_at: 'a' };
    useExpensesStore.setState({ baseline: [synced], expenses: [synced] });
    const s = useExpensesStore.getState();
    await s.deleteExpense('srv-1', 'biz-1');
    expect(ops()).toEqual(['delete_expense']);
    expect(total()).toBe(0);
    await s.restoreExpense('srv-1', 'biz-1');
    expect(ops()).toEqual([]);
    expect(total()).toBe(5000);
  });

  it('after the delete synced, undo queues restore and the row comes back locally', async () => {
    const synced: any = { id: 'srv-2', business_id: 'biz-1', amount: 700, description: 'x', category: null, date: '2026-10-05', due_date: null, note: null, status: 'approuve', created_by: 'u1', created_at: 'a', updated_at: 'a' };
    useExpensesStore.setState({ baseline: [synced], expenses: [synced] });
    const s = useExpensesStore.getState();
    await s.deleteExpense('srv-2', 'biz-1');
    mockQueue.length = 0;                                   // the delete drained
    useExpensesStore.setState({ baseline: [] });            // server list no longer holds it
    await s.restoreExpense('srv-2', 'biz-1');
    expect(ops()).toEqual(['restore_expense']);
    expect(total()).toBe(700);
  });

  it('full journey keeps total === SUM of rows at every step', async () => {
    const s = useExpensesStore.getState();
    const sum = () => useExpensesStore.getState().expenses.reduce((t, e) => t + e.amount, 0);
    const a = (await s.createExpense('biz-1', 'u1', data(25000, 'p1'), true))!;
    expect(total()).toBe(sum()); expect(total()).toBe(25000);
    await s.deleteExpense(a, 'biz-1'); expect(total()).toBe(0);
    const b = (await s.createExpense('biz-1', 'u1', data(25000, 'p1'), true))!;
    await s.updateExpense(b, 'biz-1', data(30000, 'p2')); expect(total()).toBe(30000);
    await s.deleteExpense(b, 'biz-1'); expect(total()).toBe(sum()); expect(total()).toBe(0);
  });
});
