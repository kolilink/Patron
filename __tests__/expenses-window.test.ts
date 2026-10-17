// Dépenses windowing (fix #1 of the "vendor waits on the machine" sweep): the
// list is windowed by date — an unbounded fetch + ScrollView degraded with
// every month of business age. Pins: the query is windowed but pending rows
// are always fetched; refresh keeps a widened window; extend merges without
// duplicates; the beyond-window flag is honest; the offline cache restores the
// window it was fetched with (legacy row-only caches still read).
const mockFrom = jest.fn();
const calls: string[] = [];
let queue: any[] = [];
let failNetwork = false;
let mockCache: unknown = null;

const chain: any = {};
for (const m of ['select', 'eq', 'or', 'order', 'lt', 'neq', 'in']) {
  chain[m] = (...a: any[]) => { calls.push(`${m}:${JSON.stringify(a)}`); return chain; };
}
chain.then = (res: any, rej: any) => {
  if (failNetwork) return Promise.reject(new Error('Network request failed')).then(res, rej);
  const v = queue.length ? queue.shift() : { data: null, error: null };
  return Promise.resolve(v).then(res, rej);
};

jest.mock('@/lib/db', () => ({
  ...jest.requireActual('@/lib/db'),
  enqueue: async () => {},
  cancelPendingQueueItems: async () => 0,
  getAllQueueItemsForOverlay: async () => ({ ok: [], corrupt: [] }),
  getQueueCount: async () => 0,
  getFailedQueueCount: async () => 0,
  saveExpenseCache: async () => {},
  getExpenseCache: async () => mockCache,
  getCacheTimestamp: async () => null,
}));
jest.mock('@/lib/supabase', () => ({
  supabase: { from: mockFrom, rpc: jest.fn(), auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })) } },
}));
jest.mock('@sentry/react-native', () => ({ captureMessage: jest.fn() }));
jest.mock('@/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/lib/posthog', () => ({ posthog: null }));
jest.mock('@/src/utils/notifications', () => ({ notifyEvent: jest.fn(), resolveSellerDisplayName: jest.fn() }));
jest.mock('@/stores/auth', () => ({
  useAuthStore: { getState: () => ({ session: { activeBusiness: { id: 'biz-1', currency: 'GNF' }, activeMembership: { role: 'administrateur' }, user: { id: 'u1', name: 'Fatou' } } }) },
}));
jest.mock('@/stores/products', () => ({
  useProductStore: { getState: () => ({ products: [] }) },
}));

import { useExpensesStore, initialExpenseWindowStart, previousExpenseWindowStart } from '@/stores/expenses';
import { useSyncStore } from '@/stores/sync';

type Status = 'approuve' | 'en_attente' | 'rejete';
const row = (id: string, date: string, status: Status, amountCents = 100000) => ({
  id, business_id: 'biz-1', amount: amountCents, date,
  created_at: `${date}T10:00:00.000Z`, status, created_by: 'u1',
  description: 'Test', category: null, due_date: null, note: null,
  product_id: null, product: null,
});
const profilesOk = () => ({ data: [{ id: 'u1', name: 'Fatou' }], error: null });
const mainOk = (rows: any[]) => ({ data: rows, error: null });
const probe = (count: number) => ({ count, error: null });

const orArgs = () => calls.filter(c => c.startsWith('or:')).map(c => JSON.parse(c.slice(3))[0] as string);

beforeAll(() => {
  mockFrom.mockImplementation((table: string) => { calls.push(`from:${table}`); return chain; });
});
beforeEach(() => {
  calls.length = 0;
  queue = [];
  failNetwork = false;
  mockCache = null;
  useExpensesStore.getState().reset();
  useSyncStore.setState({ syncing: false, kick: jest.fn() } as any);
});

describe('expense window helpers', () => {
  it('initial window starts on the 1st, 5 months back', () => {
    expect(initialExpenseWindowStart(new Date(2026, 9, 16))).toBe('2026-05-01');
    expect(initialExpenseWindowStart(new Date(2026, 2, 28))).toBe('2025-10-01');
  });

  it('one « charger plus » step goes 6 months further back, across year ends', () => {
    expect(previousExpenseWindowStart('2026-05-01')).toBe('2025-11-01');
    expect(previousExpenseWindowStart('2026-01-01')).toBe('2025-07-01');
  });
});

describe('expenses fetch windowing', () => {
  it('windows the query by date and always fetches pending rows whatever their date', async () => {
    queue = [mainOk([row('a1', '2026-10-05', 'approuve'), row('p1', '2020-01-15', 'en_attente')]), profilesOk(), probe(0)];
    await useExpensesStore.getState().fetchExpenses('biz-1');
    const st = useExpensesStore.getState();
    expect(st.expenses.map(e => e.id).sort()).toEqual(['a1', 'p1']);
    const [clause] = orArgs();
    expect(clause).toMatch(/^date\.gte\.\d{4}-\d{2}-01,status\.eq\.en_attente$/);
    expect(st.expensesWindowStart).toBe(clause.split(',')[0].replace('date.gte.', ''));
    expect(st.expensesWindowFor).toBe('biz-1');
  });

  it('the beyond-window probe looks for non-pending rows older than the window', async () => {
    queue = [mainOk([row('a1', '2026-10-05', 'approuve')]), profilesOk(), probe(3)];
    await useExpensesStore.getState().fetchExpenses('biz-1');
    expect(calls).toContainEqual(expect.stringMatching(/^lt:\["date","2\d{3}-\d{2}-01"\]$/));
    expect(calls).toContain('neq:["status","en_attente"]');
    expect(useExpensesStore.getState().expensesBeyondWindow).toBe(true);
  });

  it('beyond flag is false when nothing older exists', async () => {
    queue = [mainOk([row('a1', '2026-10-05', 'approuve')]), profilesOk(), probe(0)];
    await useExpensesStore.getState().fetchExpenses('biz-1');
    expect(useExpensesStore.getState().expensesBeyondWindow).toBe(false);
  });

  it('extend widens by 6 months, merges without duplicates, keeps the probe honest', async () => {
    const w0 = initialExpenseWindowStart();
    const w1 = previousExpenseWindowStart(w0);
    queue = [mainOk([row('a1', '2026-10-05', 'approuve')]), profilesOk(), probe(4)];
    await useExpensesStore.getState().fetchExpenses('biz-1');
    queue = [mainOk([row('a2', '2026-04-02', 'approuve'), row('a1', '2026-10-05', 'approuve')]), profilesOk(), probe(1)];
    await useExpensesStore.getState().extendExpensesWindow('biz-1');

    const st = useExpensesStore.getState();
    const ids = st.expenses.map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(['a1', 'a2']);
    expect(orArgs()).toEqual([
      `date.gte.${w0},status.eq.en_attente`,
      `date.gte.${w1},status.eq.en_attente`,
    ]);
    expect(st.expensesWindowStart).toBe(w1);
    expect(st.expensesBeyondWindow).toBe(true);
  });

  it('a refresh (sync drain, refocus) keeps the widened window instead of resetting it', async () => {
    const w1 = previousExpenseWindowStart(initialExpenseWindowStart());
    queue = [mainOk([row('a1', '2026-10-05', 'approuve')]), profilesOk(), probe(2)];
    await useExpensesStore.getState().fetchExpenses('biz-1');
    queue = [mainOk([row('a1', '2026-10-05', 'approuve')]), profilesOk(), probe(2)];
    await useExpensesStore.getState().extendExpensesWindow('biz-1');
    queue = [mainOk([row('a1', '2026-10-05', 'approuve')]), profilesOk(), probe(2)];
    await useExpensesStore.getState().fetchExpenses('biz-1');
    const clauses = orArgs();
    expect(clauses).toHaveLength(3);
    expect(clauses[2]).toBe(`date.gte.${w1},status.eq.en_attente`);
  });

  it('a failed extend leaves the shown window untouched and reports the failure', async () => {
    queue = [mainOk([row('a1', '2026-10-05', 'approuve')]), profilesOk(), probe(0)];
    await useExpensesStore.getState().fetchExpenses('biz-1');
    const before = useExpensesStore.getState().expenses.map(e => e.id);
    failNetwork = true;
    await useExpensesStore.getState().extendExpensesWindow('biz-1');
    const st = useExpensesStore.getState();
    expect(st.expenses.map(e => e.id)).toEqual(before);
    expect(st.error).toBeTruthy();
    expect(st.loading).toBe(false);
  });

  it('reset clears the window state', async () => {
    queue = [mainOk([row('a1', '2026-10-05', 'approuve')]), profilesOk(), probe(0)];
    await useExpensesStore.getState().fetchExpenses('biz-1');
    useExpensesStore.getState().reset();
    const st = useExpensesStore.getState();
    expect(st.expensesWindowStart).toBeNull();
    expect(st.expensesWindowFor).toBeNull();
    expect(st.expensesBeyondWindow).toBe(false);
  });
});

describe('offline cache window envelope', () => {
  it('restores the cached rows with the window they were fetched with', async () => {
    failNetwork = true;
    mockCache = { rows: [row('c1', '2026-09-01', 'approuve')], windowStart: '2025-11-01' };
    await useExpensesStore.getState().fetchExpenses('biz-1');
    const st = useExpensesStore.getState();
    expect(st.offline).toBe(true);
    expect(st.expenses.map(e => e.id)).toEqual(['c1']);
    expect(st.expensesWindowStart).toBe('2025-11-01');
    expect(st.expensesWindowFor).toBe('biz-1');
  });

  it('legacy row-only caches still read (window falls back to the initial one)', async () => {
    failNetwork = true;
    mockCache = [row('c2', '2026-09-01', 'approuve')];
    await useExpensesStore.getState().fetchExpenses('biz-1');
    const st = useExpensesStore.getState();
    expect(st.expenses.map(e => e.id)).toEqual(['c2']);
    expect(st.expensesWindowStart).toBe(initialExpenseWindowStart());
  });
});
