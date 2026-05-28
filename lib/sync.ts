import { supabase } from '@/lib/supabase';
import { getPendingOps, deleteQueueItem, markAttemptFailed } from '@/lib/db';

export type SyncResult = { synced: number; failed: number };

let _running = false;

export function isNetworkError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('fetch') ||
    msg.includes('network') ||
    msg.includes('failed to connect') ||
    msg.includes('econnrefused') ||
    msg.includes('etimedout') ||
    msg.includes('timeout') ||
    msg.includes('offline') ||
    msg.includes('load failed')
  );
}

export async function drainQueue(): Promise<SyncResult> {
  if (_running) return { synced: 0, failed: 0 };
  _running = true;

  const result: SyncResult = { synced: 0, failed: 0 };

  try {
    const ops = await getPendingOps();
    if (ops.length === 0) return result;

    for (const op of ops) {
      try {
        const payload = JSON.parse(op.payload);

        if (op.operation === 'submit_sale') {
          const { error } = await supabase.rpc('submit_sale', payload);
          if (error) throw error;
        } else if (op.operation === 'create_expense') {
          const { error } = await supabase.from('expenses').insert(payload);
          if (error) throw error;
        }

        await deleteQueueItem(op.id);
        result.synced++;
      } catch (e) {
        if (isNetworkError(e)) {
          result.failed++;
          break; // still offline — stop trying
        }
        // Server/auth/validation error — mark failed, continue with next item
        const msg = e instanceof Error ? e.message : String(e);
        await markAttemptFailed(op.id, msg);
        result.failed++;
      }
    }
  } finally {
    _running = false;
  }

  return result;
}
