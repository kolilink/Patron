// THE write funnel. Every mutation the vendor would be upset to lose goes through here; nothing outside the
// pipeline (this file, lib/db.ts, lib/outbox.ts, lib/sync.ts) writes to Supabase directly.
// Guard: __tests__/write-funnel-guard.test.ts.
//
// Contract:
//   1. apply locally first, synchronously (`applyLocal`) — she sees her change instantly, offline or not;
//   2. enqueue to the outbox (SQLite, encrypted) with an idempotency key — validated by lib/outboxValidation;
//   3. drain FIFO whenever the connection allows (useSyncStore.kick(); lib/sync.ts drainQueue);
//   4. conflicts by cost of being wrong: money paths strict (dedicated RPC ops + server-claimed key),
//      display fields last-writer-wins, links idempotent (see lib/rowWritePolicy.ts).
// New features get offline behaviour for free by calling this; they never reimplement it.
//
// Exempt (each commented at its call site): chat messages, notification read markers, auth/session plumbing.
import { enqueue } from '@/lib/db';
import { enqueueOnce } from '@/lib/outbox';
import { validateOutboxPayload } from '@/lib/outboxValidation';
import { generateId } from '@/lib/id';
import type { RowWriteOp } from '@/lib/rowWritePolicy';

// Re-exports so stores have ONE import point (jest mocks of '@/lib/db' / '@/lib/outbox' still apply underneath).
export { enqueue, enqueueOnce };
export { isQueued, validateOutboxPayload, OutboxValidationError } from '@/lib/outbox';

/** Nudge the drainer. Fire-and-forget, safe to call redundantly. Lazy import: stores/sync imports lib/sync which imports lib/db. */
export function kickDrain(): void {
  try { require('@/stores/sync').useSyncStore.getState().kick(); } catch { /* the foreground/connectivity listeners drain anyway */ }
}

export interface WriteOptions {
  /** Step 1 — synchronous local effect (store/session update). Runs BEFORE anything async. */
  applyLocal?: () => void;
  /** Runs after the durable write, before the drain is kicked (e.g. refresh a pending overlay). */
  afterEnqueue?: () => void | Promise<void>;
  /** Dedupe on payload.p_idempotency_key (default true when the payload has one). */
  once?: boolean;
}

/** The single entry for any queued operation (RPC-backed money ops and row_write alike). */
export async function write(operation: string, payload: { p_idempotency_key?: string } & Record<string, unknown>, opts: WriteOptions = {}): Promise<void> {
  // Refuse a malformed write BEFORE touching local state, so a refusal never leaves a phantom local change.
  validateOutboxPayload(operation, payload);
  opts.applyLocal?.();
  if ((opts.once ?? typeof payload.p_idempotency_key === 'string') && typeof payload.p_idempotency_key === 'string') {
    await enqueueOnce(operation, payload as { p_idempotency_key: string });
  } else {
    await enqueue(operation, payload);
  }
  try { await opts.afterEnqueue?.(); } catch { /* cosmetic refresh must never fail a durable write */ }
  kickDrain();
}

export interface RowWriteInput {
  table: 'profiles' | 'businesses' | 'clients' | 'product_suppliers';
  op: RowWriteOp;
  values?: Record<string, unknown>;
  match?: Record<string, unknown>;
  /** Stable key for a logical write; default fresh (each call is a new write). */
  key?: string;
}

/** Display/link writes (last-writer-wins / idempotent links). Money never goes through here. */
export async function writeRow(w: RowWriteInput, opts: WriteOptions = {}): Promise<{ key: string }> {
  const key = w.key ?? generateId();
  await write('row_write', { p_idempotency_key: key, table: w.table, op: w.op, values: w.values ?? {}, match: w.match ?? {} }, { once: true, ...opts });
  return { key };
}

const CLIENT_RESOLVE_CAP_MS = 3000;

/**
 * Make sure a client row exists for (business, name). Device-first: the upsert is queued durably and the caller
 * never waits on the network beyond a short cap. Returns the client's id only when the server already confirmed it
 * inside that cap; otherwise undefined — callers pass null and the drain links the debt/sale by name.
 */
export async function ensureClient(c: { businessId: string; name: string; phone?: string | null }): Promise<string | undefined> {
  const values: Record<string, unknown> = { business_id: c.businessId, name: c.name };
  if (c.phone) values.phone = c.phone;
  await writeRow({ table: 'clients', op: 'upsert', values });
  try {
    // Lazy: keeps this module (imported by every store) free of the supabase/sync import graph.
    const { supabase } = require('@/lib/supabase');
    const { withTimeout } = require('@/lib/sync');
    return await withTimeout(
      (async () => {
        await require('@/stores/sync').useSyncStore.getState().sync();
        const { data } = await supabase.from('clients').select('id').eq('business_id', c.businessId).eq('name', c.name).maybeSingle();
        return (data?.id as string | undefined) ?? undefined;
      })(),
      CLIENT_RESOLVE_CAP_MS,
    );
  } catch {
    return undefined; // offline or slow: the queued upsert and the drain's name-link cover it
  }
}
