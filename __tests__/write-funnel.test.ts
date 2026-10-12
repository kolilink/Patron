// The write funnel: device-first, FIFO, idempotent, conflict policy by cost of being wrong.
const calls: string[] = [];
const mockEnqueue = jest.fn(async (op: string) => { calls.push(`enqueue:${op}`); });
const mockEnqueueOnce = jest.fn(async (op: string) => { calls.push(`enqueueOnce:${op}`); });
const mockKick = jest.fn(() => { calls.push('kick'); });

jest.mock('@/lib/db', () => ({ enqueue: (...a: [string]) => mockEnqueue(...a) }));
jest.mock('@/lib/outbox', () => ({
  enqueueOnce: (...a: [string]) => mockEnqueueOnce(...a),
  isQueued: jest.fn(),
  validateOutboxPayload: jest.fn(),
  OutboxValidationError: class extends Error {},
}));
jest.mock('@/stores/sync', () => ({ useSyncStore: { getState: () => ({ kick: mockKick }) } }));

import { write, writeRow } from '@/lib/writeFunnel';
import { ROW_WRITE_TABLES, rowWriteProblems, WRITE_CLASSES } from '@/lib/rowWritePolicy';

const KEY = '11111111-1111-4111-8111-111111111111';
beforeEach(() => { calls.length = 0; jest.clearAllMocks(); });

describe('contract: local first → enqueue → afterEnqueue → drain', () => {
  it('applies locally BEFORE the durable write, and kicks the drain LAST', async () => {
    await writeRow(
      { table: 'profiles', op: 'update', values: { name: 'Awa' }, match: { id: 'u1' } },
      { applyLocal: () => calls.push('local'), afterEnqueue: () => { calls.push('overlay'); } },
    );
    expect(calls).toEqual(['local', 'enqueueOnce:row_write', 'overlay', 'kick']);
  });
  it('a refused (malformed) write never applies locally and never enqueues', async () => {
    await expect(writeRow({ table: 'profiles', op: 'update', values: { is_admin: true }, match: { id: 'u1' } }, { applyLocal: () => calls.push('local') })).rejects.toBeTruthy();
    expect(calls).toEqual([]);
  });
  it('write() dedupes on the idempotency key (retry / double tap never queues twice)', async () => {
    await write('row_write', { p_idempotency_key: KEY, table: 'profiles', op: 'update', values: { name: 'A' }, match: { id: 'u' } }, { once: true });
    expect(mockEnqueueOnce).toHaveBeenCalledTimes(1);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
  it('a failing cosmetic refresh never fails the durable write', async () => {
    await expect(write('row_write', { p_idempotency_key: KEY, table: 'profiles', op: 'update', values: { name: 'A' }, match: { id: 'u' } }, { afterEnqueue: () => { throw new Error('x'); } })).resolves.toBeUndefined();
    expect(calls).toContain('kick');
  });
});

describe('conflict policy by cost of being wrong', () => {
  it('money tables can never be row writes — they have dedicated RPC operations with a server-claimed key', () => {
    for (const t of ['sale_orders', 'so_lines', 'payments', 'expenses', 'stock_moves', 'supplier_debts', 'products', 'purchase_orders']) {
      expect(rowWriteProblems({ p_idempotency_key: KEY, table: t, op: 'update', values: { x: 1 }, match: { id: 'a' } })[0]).toMatch(/not a row_write table/);
    }
  });
  it('display fields are last-writer-wins; links are idempotent; nothing else is allowed', () => {
    expect(ROW_WRITE_TABLES.profiles.conflict).toBe('display-lww');
    expect(ROW_WRITE_TABLES.clients.conflict).toBe('display-lww');
    expect(ROW_WRITE_TABLES.product_suppliers.conflict).toBe('link');
    expect(Object.keys(ROW_WRITE_TABLES).sort()).toEqual(['businesses', 'clients', 'product_suppliers', 'profiles']);
  });
  it('every exemption names its reason', () => {
    for (const reason of Object.values(WRITE_CLASSES.exempt)) expect(reason.length).toBeGreaterThan(10);
  });
});
