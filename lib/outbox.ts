// Outbox helpers shared by the stores that write local-first.
import { enqueue, getAllQueueItemsForOverlay } from '@/lib/db';

// Every payload is validated inside enqueue() itself (lib/db.ts), so enqueueOnce
// and any direct enqueue() caller go through the same chokepoint.
export { validateOutboxPayload, OutboxValidationError } from '@/lib/outboxValidation';

/**
 * Enqueue unless an item for this operation + idempotency key is already in the
 * outbox. A retry after a failure (or two taps in one tick) carries the same
 * key; locally that must never leave two copies — the server would dedup the
 * pair, but the overlay would show it twice until then. If the outbox can't be
 * read to check, enqueue anyway: the server's claim on the key still dedups.
 */
export async function enqueueOnce(operation: string, payload: { p_idempotency_key: string }): Promise<void> {
  try {
    const { ok } = await getAllQueueItemsForOverlay();
    if (ok.some(i => i.operation === operation && i.idempotency_key === payload.p_idempotency_key)) return;
  } catch { /* can't read the outbox to check: enqueue anyway */ }
  await enqueue(operation, payload);
}

/** True while an item with this key is still waiting in the outbox. */
export async function isQueued(operation: string, key: string): Promise<boolean> {
  try {
    const { ok } = await getAllQueueItemsForOverlay();
    return ok.some(i => i.operation === operation && i.idempotency_key === key && i.status !== 'failed_permanent');
  } catch {
    return false;
  }
}
