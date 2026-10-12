// row_write through the real drainQueue: FIFO order, idempotent retry, per-op semantics.
const mockOps = jest.fn();
const mockDelete = jest.fn().mockResolvedValue(undefined);
const mockResched = jest.fn().mockResolvedValue(undefined);
const mockPermFail = jest.fn().mockResolvedValue(undefined);

jest.mock('@/lib/db', () => ({
  getPendingOpsForDrain: (...a: unknown[]) => mockOps(...a),
  deleteQueueItem: (...a: unknown[]) => mockDelete(...a),
  rescheduleOp: (...a: unknown[]) => mockResched(...a),
  markOpPermanentlyFailed: (...a: unknown[]) => mockPermFail(...a),
  markOpCorrupt: jest.fn(),
  getQueueCount: jest.fn().mockResolvedValue(0),
}));

const log: string[] = [];
let nextError: { code?: string; message?: string } | null = null;
const chain = (table: string) => {
  const rec = (name: string) => (...args: unknown[]) => {
    log.push(`${table}.${name}:${JSON.stringify(args)}`);
    const err = nextError; nextError = null;
    const r: Record<string, unknown> = { error: err, then: (res: (v: unknown) => void) => res({ error: err }) };
    r.match = (m: unknown) => { log.push(`${table}.match:${JSON.stringify(m)}`); return r; };
    return r;
  };
  return { insert: rec('insert'), upsert: rec('upsert'), update: rec('update'), delete: rec('delete') };
};
jest.mock('@/lib/supabase', () => ({
  supabase: { rpc: jest.fn(), from: (t: string) => chain(t), auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })) } },
}));

import { drainQueue } from '@/lib/sync';

const op = (id: number, payload: object) => ({
  id, operation: 'row_write', payload: JSON.stringify(payload), created_at: 't', queued_at: 't', entity_type: 'row_write',
  idempotency_key: (payload as { p_idempotency_key: string }).p_idempotency_key, status: 'pending' as const, next_attempt_at: 't', attempts: 0, last_error: null,
});
const K = (n: number) => `0000000${n}-0000-4000-8000-000000000000`;

beforeEach(() => { log.length = 0; nextError = null; jest.clearAllMocks(); });

describe('row_write drains FIFO', () => {
  it('executes queued writes in queue order, each once, then removes them', async () => {
    mockOps.mockResolvedValueOnce({ ok: [
      op(1, { p_idempotency_key: K(1), table: 'clients', op: 'upsert', values: { business_id: 'b', name: 'Awa' }, match: {} }),
      op(2, { p_idempotency_key: K(2), table: 'profiles', op: 'update', values: { name: 'Mamadou' }, match: { id: 'u' } }),
      op(3, { p_idempotency_key: K(3), table: 'product_suppliers', op: 'delete', values: {}, match: { product_id: 'p', supplier_id: 's' } }),
    ], corrupt: [] });
    await drainQueue();
    expect(log.filter(l => !l.includes('.match:')).map(l => l.split(':')[0])).toEqual(['clients.upsert', 'profiles.update', 'product_suppliers.delete']);
    expect(mockDelete.mock.calls.map(c => c[0])).toEqual([1, 2, 3]);
  });
  it('update/delete are scoped by `match` (last-writer-wins on exactly that row)', async () => {
    mockOps.mockResolvedValueOnce({ ok: [op(1, { p_idempotency_key: K(1), table: 'profiles', op: 'update', values: { name: 'X' }, match: { id: 'u1' } })], corrupt: [] });
    await drainQueue();
    expect(log).toContain('profiles.match:{"id":"u1"}');
  });
  it('clients upsert uses the (business, name) conflict target — a repeat never duplicates', async () => {
    mockOps.mockResolvedValueOnce({ ok: [op(1, { p_idempotency_key: K(1), table: 'clients', op: 'upsert', values: { business_id: 'b', name: 'Awa' }, match: {} })], corrupt: [] });
    await drainQueue();
    expect(log[0]).toContain('"onConflict":"business_id,name"');
  });
  it('a link insert that already exists (23505) is success: idempotent retry', async () => {
    nextError = { code: '23505', message: 'duplicate' };
    mockOps.mockResolvedValueOnce({ ok: [op(1, { p_idempotency_key: K(1), table: 'product_suppliers', op: 'insert', values: { product_id: 'p', supplier_id: 's' }, match: {} })], corrupt: [] });
    await drainQueue();
    expect(mockDelete).toHaveBeenCalledWith(1);
    expect(mockPermFail).not.toHaveBeenCalled();
  });
  it('a network failure reschedules (stays queued) and stops the pass — FIFO preserved', async () => {
    nextError = { message: 'Network request failed' };
    mockOps.mockResolvedValueOnce({ ok: [
      op(1, { p_idempotency_key: K(1), table: 'profiles', op: 'update', values: { name: 'A' }, match: { id: 'u' } }),
      op(2, { p_idempotency_key: K(2), table: 'profiles', op: 'update', values: { name: 'B' }, match: { id: 'u' } }),
    ], corrupt: [] });
    await drainQueue();
    expect(mockResched).toHaveBeenCalledTimes(1);
    expect(mockDelete).not.toHaveBeenCalled();
    expect(log.filter(l => l.startsWith('profiles.update')).length).toBe(1);
  });
  it('a real server refusal (RLS) is permanent immediately — retrying cannot help', async () => {
    nextError = { code: '42501', message: 'new row violates row-level security policy' };
    mockOps.mockResolvedValueOnce({ ok: [op(1, { p_idempotency_key: K(1), table: 'profiles', op: 'update', values: { name: 'A' }, match: { id: 'u' } })], corrupt: [] });
    await drainQueue();
    expect(mockPermFail).toHaveBeenCalledTimes(1);
  });
});
