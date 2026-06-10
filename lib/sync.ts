import { supabase } from '@/lib/supabase';
import { getPendingOps, deleteQueueItem, markAttemptFailed } from '@/lib/db';

export type SyncResult = { synced: number; failed: number };

let _running = false;

export function isNetworkError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true;
  let msg: string;
  if (err instanceof Error) {
    msg = err.message;
  } else if (err && typeof err === 'object' && 'message' in err) {
    msg = String((err as { message: unknown }).message);
  } else {
    msg = String(err);
  }
  msg = msg.toLowerCase();
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

async function executeOp(operation: string, payload: Record<string, unknown>): Promise<void> {
  switch (operation) {
    case 'submit_sale': {
      const { error } = await supabase.rpc('submit_sale', payload);
      if (error) throw error;
      break;
    }
    case 'create_expense': {
      const { error } = await supabase.from('expenses').insert(payload);
      if (error) throw error;
      break;
    }
    case 'cancel_sale': {
      const { error } = await supabase.rpc('cancel_sale', payload);
      if (error) throw error;
      break;
    }
    case 'update_expense': {
      const { id, ...patch } = payload;
      const { error } = await supabase.from('expenses').update(patch).eq('id', id as string);
      if (error) throw error;
      break;
    }
    case 'approve_expense':
    case 'reject_expense': {
      const { id, ...patch } = payload;
      const { error } = await supabase.from('expenses').update(patch).eq('id', id as string);
      if (error) throw error;
      break;
    }
    case 'record_payment': {
      const { payments, fully_paid_ids } = payload as {
        payments: object[];
        fully_paid_ids: string[];
      };
      const { error } = await supabase.from('payments').insert(payments);
      if (error) throw error;
      if (fully_paid_ids.length > 0) {
        await supabase
          .from('sale_orders')
          .update({ status: 'paye', paid_at: new Date().toISOString() })
          .in('id', fully_paid_ids);
      }
      break;
    }
    case 'create_product': {
      const { product, stockMove } = payload as {
        product: object;
        stockMove: object | null;
      };
      const { error } = await supabase.from('products').insert(product);
      if (error) throw error;
      if (stockMove) {
        await supabase.from('stock_moves').insert(stockMove);
      }
      break;
    }
    case 'update_product': {
      const { id, ...patch } = payload;
      const { error } = await supabase.from('products').update(patch).eq('id', id as string);
      if (error) throw error;
      break;
    }
    case 'adjust_stock': {
      const { stockMove, productUpdate } = payload as {
        stockMove: object;
        productUpdate: { id: string; stock_qty: number };
      };
      const { error } = await supabase.from('stock_moves').insert(stockMove);
      if (error) throw error;
      await supabase
        .from('products')
        .update({ stock_qty: productUpdate.stock_qty })
        .eq('id', productUpdate.id);
      break;
    }
    default:
      // Unknown operation type — mark failed so it doesn't block the queue.
      throw new Error(`Unknown operation: ${operation}`);
  }
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
        const payload = JSON.parse(op.payload) as Record<string, unknown>;
        await executeOp(op.operation, payload);
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
