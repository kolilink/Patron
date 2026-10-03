// drainQueue behavior — the engine that replays queued sales when back
// online. §3 of the offline-first rewrite replaced the old
// getPendingOps/markAttemptFailed (attempts-cap, dead_ops-graveyard) shape
// with getPendingOpsForDrain/rescheduleOp/markOpPermanentlyFailed/
// markOpCorrupt (three-branch classification, no cap, retries
// indefinitely). These tests guard that classification: what retries with
// backoff, what's permanent immediately, what's corrupt, and that ordering
// (stop-on-network-error) is preserved.

const mockGetPendingOpsForDrain = jest.fn();
const mockDeleteQueueItem = jest.fn();
const mockRescheduleOp = jest.fn();
const mockMarkOpPermanentlyFailed = jest.fn();
const mockMarkOpCorrupt = jest.fn();

jest.mock('@/lib/db', () => ({
  getPendingOpsForDrain: mockGetPendingOpsForDrain,
  deleteQueueItem: mockDeleteQueueItem,
  rescheduleOp: mockRescheduleOp,
  markOpPermanentlyFailed: mockMarkOpPermanentlyFailed,
  markOpCorrupt: mockMarkOpCorrupt,
  getQueueCount: jest.fn().mockResolvedValue(0),
}));

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: jest.fn(),
    from: jest.fn(() => ({ insert: jest.fn().mockResolvedValue({ error: null }) })),
    auth: {
      onAuthStateChange: jest.fn(() => ({
        data: { subscription: { unsubscribe: jest.fn() } },
      })),
    },
  },
}));

import { drainQueue } from '@/lib/sync';
import { supabase } from '@/lib/supabase';

function makeSaleOp(id: number, attempts = 0) {
  return {
    id,
    operation: 'submit_sale',
    payload: JSON.stringify({
      p_business_id: 'biz-1',
      p_seller_id: 'user-1',
      p_total_amount: 1000,
      p_cart: [],
    }),
    created_at: '2026-01-01T00:00:00Z',
    queued_at: '2026-01-01T00:00:00Z',
    entity_type: 'vente',
    idempotency_key: null,
    status: 'pending' as const,
    next_attempt_at: '2026-01-01T00:00:00Z',
    attempts,
    last_error: null,
  };
}

function makeCarnetDebtOp(id: number) {
  return {
    id,
    operation: 'submit_carnet_debt',
    payload: JSON.stringify({
      p_business_id: 'biz-1',
      p_seller_id: 'user-1',
      p_customer_name: 'Mamadou',
      p_amount: 500000,
      p_client_id: null,
      p_idempotency_key: 'key-1',
    }),
    created_at: '2026-01-01T00:00:00Z',
    queued_at: '2026-01-01T00:00:00Z',
    entity_type: 'dette',
    idempotency_key: 'key-1',
    status: 'pending' as const,
    next_attempt_at: '2026-01-01T00:00:00Z',
    attempts: 0,
    last_error: null,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDeleteQueueItem.mockResolvedValue(undefined);
  mockRescheduleOp.mockResolvedValue(undefined);
  mockMarkOpPermanentlyFailed.mockResolvedValue(undefined);
  mockMarkOpCorrupt.mockResolvedValue(undefined);
});

describe('drainQueue', () => {
  it('returns synced:0 failed:0 with no queue calls when both ok and corrupt are empty', async () => {
    mockGetPendingOpsForDrain.mockResolvedValueOnce({ ok: [], corrupt: [] });
    const result = await drainQueue();
    expect(result.synced).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.rejectedPayments).toEqual([]);
    expect(result.syncHealthEvents).toEqual([]);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('syncs a pending item and deletes it from the queue', async () => {
    mockGetPendingOpsForDrain.mockResolvedValueOnce({ ok: [makeSaleOp(1)], corrupt: [] });
    (supabase.rpc as jest.Mock).mockResolvedValueOnce({ error: null });

    const result = await drainQueue();

    expect(result.synced).toBe(1);
    expect(result.failed).toBe(0);
    expect(supabase.rpc).toHaveBeenCalledWith('submit_sale', expect.objectContaining({
      p_business_id: 'biz-1',
    }));
    expect(mockDeleteQueueItem).toHaveBeenCalledWith(1);
  });

  it('stops immediately on network error, reschedules with backoff (not a hard cap), and does not attempt remaining items', async () => {
    mockGetPendingOpsForDrain.mockResolvedValueOnce({ ok: [makeSaleOp(1), makeSaleOp(2)], corrupt: [] });
    (supabase.rpc as jest.Mock).mockRejectedValueOnce(new Error('Failed to fetch'));

    const result = await drainQueue();

    expect(result.failed).toBe(1);
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(mockDeleteQueueItem).not.toHaveBeenCalled();
    expect(mockMarkOpPermanentlyFailed).not.toHaveBeenCalled();
    // Rescheduled (retried later), never permanently failed and never
    // capped — this is the entire point of the §3 rework over the old
    // MAX_SYNC_ATTEMPTS/dead_ops design.
    expect(mockRescheduleOp).toHaveBeenCalledWith(1, expect.any(String), expect.any(String));
    const [, nextAttemptAt] = mockRescheduleOp.mock.calls[0];
    expect(new Date(nextAttemptAt).getTime()).toBeGreaterThan(Date.now());
    expect(result.syncHealthEvents).toContainEqual(expect.objectContaining({
      name: 'sync_drain_failed_network', businessId: 'biz-1',
    }));
  });

  it('P1-2: a genuine business rejection (P0001) is marked permanently failed immediately — not retried, continues to next item', async () => {
    mockGetPendingOpsForDrain.mockResolvedValueOnce({ ok: [makeSaleOp(1), makeSaleOp(2)], corrupt: [] });
    (supabase.rpc as jest.Mock)
      .mockResolvedValueOnce({ error: { code: 'P0001', message: 'Quantité insuffisante en stock' } }) // item 1: business rejection
      .mockResolvedValueOnce({ error: null }); // item 2: success

    const result = await drainQueue();

    expect(result.synced).toBe(1);
    expect(result.failed).toBe(1);
    expect(mockMarkOpPermanentlyFailed).toHaveBeenCalledWith(1, expect.any(String));
    expect(mockRescheduleOp).not.toHaveBeenCalled(); // never retried
    expect(mockDeleteQueueItem).toHaveBeenCalledWith(2);
    expect(result.syncHealthEvents).toContainEqual(expect.objectContaining({
      name: 'sync_op_failed_permanent', businessId: 'biz-1',
    }));
  });

  it('P1-2: an unexpected non-network, non-P0001 error (e.g. invalid input syntax) reschedules with backoff — never failed_permanent on first failure', async () => {
    mockGetPendingOpsForDrain.mockResolvedValueOnce({ ok: [makeSaleOp(1), makeSaleOp(2)], corrupt: [] });
    (supabase.rpc as jest.Mock)
      .mockResolvedValueOnce({ error: { message: 'invalid input syntax' } }) // item 1: unexpected, not P0001
      .mockResolvedValueOnce({ error: null }); // item 2: success

    const result = await drainQueue();

    expect(result.synced).toBe(1);
    expect(result.failed).toBe(1);
    expect(mockMarkOpPermanentlyFailed).not.toHaveBeenCalled(); // never permanently dropped
    expect(mockRescheduleOp).toHaveBeenCalledWith(1, expect.any(String), expect.any(String));
    expect(mockDeleteQueueItem).toHaveBeenCalledWith(2);
    expect(result.syncHealthEvents).toContainEqual(expect.objectContaining({
      name: 'sync_drain_failed_network', businessId: 'biz-1',
    }));
  });

  it('P1-2: an HTTP 5xx-shaped error reschedules with backoff like a network error — never failed_permanent on first failure', async () => {
    mockGetPendingOpsForDrain.mockResolvedValueOnce({ ok: [makeSaleOp(1)], corrupt: [] });
    (supabase.rpc as jest.Mock)
      .mockResolvedValueOnce({ error: { code: '502', message: 'Service unavailable' } });

    const result = await drainQueue();

    expect(result.failed).toBe(1);
    expect(mockMarkOpPermanentlyFailed).not.toHaveBeenCalled();
    expect(mockRescheduleOp).toHaveBeenCalledWith(1, expect.any(String), expect.any(String));
    expect(result.syncHealthEvents).toContainEqual(expect.objectContaining({
      name: 'sync_drain_failed_network', businessId: 'biz-1',
    }));
  });

  it('a corrupt (decrypt-failed) row is classified via markOpCorrupt before any RPC attempt, and does not block ok items', async () => {
    const corruptStub = { id: 99, operation: 'submit_sale', entity_type: 'vente', idempotency_key: null, status: 'pending' as const, queued_at: '2026-01-01T00:00:00Z', attempts: 0, last_error: 'decrypt failed' };
    mockGetPendingOpsForDrain.mockResolvedValueOnce({ ok: [makeSaleOp(1)], corrupt: [corruptStub] });
    (supabase.rpc as jest.Mock).mockResolvedValueOnce({ error: null });

    const result = await drainQueue();

    expect(mockMarkOpCorrupt).toHaveBeenCalledWith(99, 'decrypt failed');
    // Two calls total, not one: the corrupt row never reaches an RPC call
    // at all (that's the real property under test), but the one genuine
    // "ok" item both submits (submit_sale) AND fires §9b's fire-and-forget
    // sync-lag telemetry (log_sync_lag) once it succeeds — a real, new,
    // additional call, not a bug.
    expect(supabase.rpc).toHaveBeenCalledTimes(2);
    expect(supabase.rpc).toHaveBeenCalledWith('submit_sale', expect.anything());
    expect(supabase.rpc).toHaveBeenCalledWith('log_sync_lag', expect.objectContaining({ p_operation: 'submit_sale' }));
    expect(result.synced).toBe(1); // the ok item still synced normally
    expect(result.syncHealthEvents).toContainEqual(expect.objectContaining({
      name: 'sync_op_failed_corrupt', metadata: expect.objectContaining({ stage: 'decrypt' }),
    }));
  });

  it('§9b regression: a synchronous throw from the fire-and-forget log_sync_lag call never affects the item\'s own classification', async () => {
    // The real bug this guards: an earlier version placed the log_sync_lag
    // call INSIDE the same try block that classifies real failures. A
    // synchronous throw there (exactly what happens here — the mock has no
    // queued return value left, so calling .then on the resulting
    // undefined throws synchronously) landed in that same catch and
    // permanently mis-marked an already-successful item as ALSO failed.
    mockGetPendingOpsForDrain.mockResolvedValueOnce({ ok: [makeSaleOp(1)], corrupt: [] });
    // Exactly one queued value, consumed by submit_sale — log_sync_lag's
    // own call is guaranteed to find nothing queued and throw synchronously
    // on `.then` of undefined, which is the precise condition under test.
    (supabase.rpc as jest.Mock).mockResolvedValueOnce({ error: null });

    const result = await drainQueue();

    expect(result.synced).toBe(1);
    expect(result.failed).toBe(0); // NOT 1 — this is what the bug got wrong
    expect(mockDeleteQueueItem).toHaveBeenCalledWith(1);
    expect(mockMarkOpPermanentlyFailed).not.toHaveBeenCalled();
  });

  it('a row that decrypts fine but is not valid JSON is classified corrupt (parse stage), not permanent', async () => {
    const badJsonOp = { ...makeSaleOp(7), payload: 'not valid json {{{' };
    mockGetPendingOpsForDrain.mockResolvedValueOnce({ ok: [badJsonOp], corrupt: [] });

    const result = await drainQueue();

    expect(supabase.rpc).not.toHaveBeenCalled(); // never even attempted
    expect(mockMarkOpCorrupt).toHaveBeenCalledWith(7, expect.any(String));
    expect(mockMarkOpPermanentlyFailed).not.toHaveBeenCalled();
    expect(result.syncHealthEvents).toContainEqual(expect.objectContaining({
      name: 'sync_op_failed_corrupt', metadata: expect.objectContaining({ stage: 'parse' }),
    }));
  });

  it('backoff grows with attempts (exponential, not flat) — a 4th attempt schedules further out than a 1st', async () => {
    mockGetPendingOpsForDrain.mockResolvedValueOnce({ ok: [makeSaleOp(1, 0)], corrupt: [] });
    (supabase.rpc as jest.Mock).mockRejectedValueOnce(new Error('Failed to fetch'));
    await drainQueue();
    const [, firstNext] = mockRescheduleOp.mock.calls[0];
    const firstDelayMs = new Date(firstNext).getTime() - Date.now();

    jest.clearAllMocks();
    mockGetPendingOpsForDrain.mockResolvedValueOnce({ ok: [makeSaleOp(1, 3)], corrupt: [] });
    (supabase.rpc as jest.Mock).mockRejectedValueOnce(new Error('Failed to fetch'));
    await drainQueue();
    const [, laterNext] = mockRescheduleOp.mock.calls[0];
    const laterDelayMs = new Date(laterNext).getTime() - Date.now();

    // Generous bound (jitter is +/-20%) — this only needs to prove growth,
    // not pin an exact schedule value.
    expect(laterDelayMs).toBeGreaterThan(firstDelayMs * 2);
  });

  it('syncs a queued submit_carnet_debt item (the offline credit-entry flow)', async () => {
    mockGetPendingOpsForDrain.mockResolvedValueOnce({ ok: [makeCarnetDebtOp(3)], corrupt: [] });
    (supabase.rpc as jest.Mock).mockResolvedValueOnce({ error: null });

    const result = await drainQueue();

    expect(result.synced).toBe(1);
    expect(supabase.rpc).toHaveBeenCalledWith('submit_carnet_debt', expect.objectContaining({
      p_business_id: 'biz-1',
      p_customer_name: 'Mamadou',
      p_amount: 500000,
      p_idempotency_key: 'key-1',
    }));
    expect(mockDeleteQueueItem).toHaveBeenCalledWith(3);
  });

  it('surfaces a rejected record_payment as rejectedPayments instead of a silent failure', async () => {
    const paymentOp = {
      id: 5,
      operation: 'record_payment',
      payload: JSON.stringify({
        p_sale_id: 'sale-1',
        p_business_id: 'biz-1',
        p_amount: 1650000,
        p_method: 'especes',
        p_date: '2026-06-30',
      }),
      created_at: '2026-06-30T00:00:00Z',
      queued_at: '2026-06-30T00:00:00Z',
      entity_type: 'paiement',
      idempotency_key: null,
      status: 'pending' as const,
      next_attempt_at: '2026-06-30T00:00:00Z',
      attempts: 0,
      last_error: null,
    };
    mockGetPendingOpsForDrain.mockResolvedValueOnce({ ok: [paymentOp], corrupt: [] });
    (supabase.rpc as jest.Mock).mockResolvedValueOnce({
      error: { code: 'P0001', message: 'Le montant dépasse le solde restant dû' },
    });

    const result = await drainQueue();

    expect(result.failed).toBe(1);
    expect(result.rejectedPayments).toEqual(['Le montant dépasse le solde restant dû']);
    expect(mockMarkOpPermanentlyFailed).toHaveBeenCalledWith(5, 'Le montant dépasse le solde restant dû');
  });
});
