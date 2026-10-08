// A carnet payment that fails must (1) say so in place, (2) keep her input, and
// (3) be safe to retry: the retry carries the SAME idempotency key, so it can
// never record the payment twice — locally (one outbox row) or at the server
// (migration_v203/v205 claim the key; see the integration suites).

import fs from 'fs';
import path from 'path';

const mockQueue: any[] = [];
const rpcCalls: { fn: string; args: any }[] = [];
let rpcImpl: (fn: string, args: any) => Promise<{ data: any; error: any }>;
let countThrows = false;

jest.mock('@/lib/db', () => ({
  enqueue: jest.fn(async (operation: string, payload: any) => {
    mockQueue.push({ operation, idempotency_key: payload.p_idempotency_key, payload });
  }),
  getAllQueueItemsForOverlay: async () => ({ ok: mockQueue.map(q => ({ ...q })), corrupt: [] }),
  getQueueCount: jest.fn(async () => { if (countThrows) throw new Error('count failed'); return mockQueue.length; }),
  saveVentesCache: jest.fn().mockResolvedValue(undefined),
  getVentesCache: jest.fn().mockResolvedValue(null),
  getCacheTimestamp: jest.fn().mockResolvedValue(null),
  openDb: jest.fn(),
}));
jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (fn: string, args: any) => { rpcCalls.push({ fn, args }); return rpcImpl(fn, args); },
    from: jest.fn(),
    auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })) },
  },
}));
jest.mock('@/stores/sync', () => ({
  useSyncStore: { getState: () => ({ kick: jest.fn() }), setState: jest.fn() },
}));
jest.mock('@/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/lib/posthog', () => ({ posthog: null }));
jest.mock('@/src/utils/notifications', () => ({ notifyEvent: jest.fn() }));
jest.mock('@/stores/auth', () => ({
  useAuthStore: { getState: () => ({ session: { activeBusiness: { currency: 'GNF' }, user: { id: 'u1', name: 'Fatou' } } }) },
}));

import { useVentesStore, type Vente } from '@/stores/ventes';

const NETWORK_ERROR = { message: 'Failed to fetch', code: '', details: '', hint: '' };

const sale: Vente = {
  id: 'sale-1', business_id: 'biz-1', customer_name: 'Aïssatou', client_id: null, seller_id: 'u1', seller_name: 'V',
  status: 'credit', is_credit: true, total_amount: 16500, discount_amount: 0, paid_at: null, sale_date: '2026-06-20',
  created_at: '2026-06-20T00:00:00Z', cancelled_at: null, cancellation_reason: null, edit_count: 0, last_edited_at: null,
  profit: null, amount_paid: 0,
};

beforeEach(() => {
  mockQueue.length = 0; rpcCalls.length = 0; countThrows = false;
  rpcImpl = async () => ({ data: null, error: NETWORK_ERROR });
  useVentesStore.setState({ sales: [sale], saving: false, error: null });
  (useVentesStore as any).setState({ refreshPendingOverlay: async () => {} });
});

const payClient = (key?: string) => useVentesStore.getState().recordClientPayment('Aïssatou', 'biz-1', 5000, 'especes', '2026-10-04', key);
const paySale = (key?: string) => useVentesStore.getState().recordPayment('sale-1', 5000, 'especes', '2026-10-04', key);

import { enqueue } from '@/lib/db';

describe('a forced payment failure speaks and records nothing', () => {
  it('a local (SQLite) write failure → ok:false, nothing queued, nothing stuck, no network attempted', async () => {
    (enqueue as jest.Mock).mockRejectedValueOnce(new Error('SQLite disk I/O error'));
    const r = await payClient('key-A');
    expect(r.ok).toBe(false);
    expect(mockQueue).toHaveLength(0);
    expect(useVentesStore.getState().saving).toBe(false);
    expect(rpcCalls).toHaveLength(0);
  });
  it('a malformed payload is refused by the outbox validator → ok:false, no generic message', async () => {
    const { OutboxValidationError } = jest.requireActual('@/lib/outboxValidation');
    (enqueue as jest.Mock).mockRejectedValueOnce(new OutboxValidationError('record_client_payment', ['p_amount must be positive']));
    const r = await payClient('key-B');
    expect(r.ok).toBe(false);
    expect(useVentesStore.getState().error).toBeNull();   // enqueue() already toasted the specific one
  });
});

describe('retry after a failure can never double-record', () => {
  it('fail, then retry with the SAME key: exactly one outbox row, never a network call', async () => {
    (enqueue as jest.Mock).mockRejectedValueOnce(new Error('SQLite disk I/O error'));
    expect((await payClient('key-C')).ok).toBe(false);
    expect((await payClient('key-C')).ok).toBe(true);
    expect(mockQueue.map(q => q.idempotency_key)).toEqual(['key-C']);   // the server claims this key once
    expect(rpcCalls).toHaveLength(0);
  });

  it('the write is queued once even if the confirmation step throws afterwards, and a retry adds no second row', async () => {
    countThrows = true;                                  // a post-write step blows up
    const first = await payClient('key-D');
    expect(first.ok).toBe(true);                         // the write is durable → NOT reported as a failure
    expect(mockQueue).toHaveLength(1);
    const retry = await payClient('key-D');              // she (or a double tap) tries again with the same key
    expect(retry.ok).toBe(true);
    expect(mockQueue).toHaveLength(1);                   // still one outbox row
  });

  it('the same for a single-sale payment', async () => {
    countThrows = true;
    expect((await paySale('key-E')).ok).toBe(true);
    expect((await paySale('key-E')).ok).toBe(true);
    expect(mockQueue.filter(q => q.operation === 'record_payment')).toHaveLength(1);
  });

  it('two taps in the same instant collapse into one outbox row', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    (enqueue as jest.Mock).mockImplementationOnce(async (operation: string, payload: any) => {
      await gate; mockQueue.push({ operation, idempotency_key: payload.p_idempotency_key, payload });
    });
    const a = payClient('key-F');
    const b = payClient('key-F');
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(mockQueue).toHaveLength(1);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(false);                           // swallowed, not a second payment
  });

  it('a different key (changed amount/method/date) is a different logical payment', async () => {
    countThrows = true;
    await payClient('key-G');
    await payClient('key-H');
    expect(mockQueue).toHaveLength(2);
  });
});

describe('the carnet screen wires the failure in place', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'app/(app)/clients/[name].tsx'), 'utf8');
  const handle = src.slice(src.indexOf('const handleRecord = useCallback'), src.indexOf('const handleRecord = useCallback') + 3500);

  it('handleRecord has a failure branch (it used to be silent): flags it, keeps the sheet open', () => {
    expect(handle).toMatch(/if \(!result\.ok\)\s*\{/);
    expect(handle).toMatch(/setPayFailed\(\{ reason: result\.reason \}\)/);
    const failureBranch = handle.slice(handle.indexOf('if (!result.ok)'), handle.indexOf('if (result.ok)'));
    expect(failureBranch).not.toMatch(/setShowPayModal\(false\)/);   // her input stays in the open sheet
    expect(failureBranch).not.toMatch(/toast\./);                    // persistent inline, never a 3-second toast
  });
  it('the retry reuses one idempotency key per logical payment (amount|method|date|target)', () => {
    expect(handle).toMatch(/const sig = `\$\{specificSaleId \?\? 'client'\}\|\$\{amount\}\|\$\{method\}\|\$\{date\}`/);
    expect(handle).toMatch(/payAttempt\.current\.sig !== sig/);
    expect(handle).toMatch(/recordClientPayment\(displayName, businessId, amount, method, date, idempotencyKey\)/);
    expect(handle).toMatch(/recordPayment\(specificSaleId, amount, method, date, idempotencyKey\)/);
  });
  it('the sheet shows the one failure surface with the exact vocabulary and a single Réessayer', () => {
    expect(src).toMatch(/FAILURE_COPY\.paymentNotRecorded\.what/);
    expect(src).toMatch(/action: \{ label: 'Réessayer', onPress: handleRecord \}/);
    expect(src).toMatch(/<FailureView failure=\{failure\}/);
  });
});
