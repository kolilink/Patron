import { supabase } from '@/lib/supabase';
import { getPendingOps, deleteQueueItem, markAttemptFailed } from '@/lib/db';
import { notifyEvent } from '@/src/utils/notifications';
import { formatAmount } from '@/src/utils/format';

export type SyncResult = {
  synced: number;
  failed: number;
  // Payment-specific rejections (e.g. a debt already settled by another queued
  // payment before this one synced) — surfaced separately so the caller can
  // alert the merchant instead of letting them vanish into a silent retry.
  rejectedPayments: string[];
};

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

// Builds the "{qty} {product}" fragment for the sale-completed notification,
// mirroring stores/sales.ts's describeSaleForNotification but operating on
// the raw cart JSON stored in the queue (no CartLine/Product objects survive
// a trip through SQLite).
function describeQueuedCart(
  cart: { product_id: string; product_name: string; qty: number; variant_name?: string | null }[],
): string {
  const byProduct = new Set(cart.map(l => l.product_id));
  const totalQty = cart.reduce((s, l) => s + l.qty, 0);
  if (byProduct.size > 1) return `${totalQty} produits`;
  const first = cart[0];
  if (!first) return `${totalQty} article${totalQty > 1 ? 's' : ''}`;
  return first.variant_name ? `${totalQty} ${first.product_name} ${first.variant_name}` : `${totalQty} ${first.product_name}`;
}

// The online path (stores/sales.ts) notifies admins/managers right after a
// successful submit_sale call — the offline-queue replay skipped this
// entirely, so sales made offline (this app's core low-connectivity use
// case) never generated the notification once synced. Best-effort: a lookup
// failure here must never affect the sync result itself.
async function notifyQueuedSaleSynced(payload: Record<string, unknown>): Promise<void> {
  try {
    const businessId = payload.p_business_id as string;
    const sellerId = payload.p_seller_id as string;
    const cart = (payload.p_cart as { product_id: string; product_name: string; qty: number; variant_name?: string | null }[]) ?? [];
    const totalCents = (payload.p_total_amount as number) ?? 0;

    const [{ data: biz }, { data: membership }, { data: profile }] = await Promise.all([
      supabase.from('businesses').select('currency').eq('id', businessId).maybeSingle(),
      supabase.from('memberships').select('display_name').eq('business_id', businessId).eq('user_id', sellerId).maybeSingle(),
      supabase.from('profiles').select('name').eq('id', sellerId).maybeSingle(),
    ]);

    const currency = (biz as { currency: string } | null)?.currency ?? 'GNF';
    const sellerName = (membership as { display_name: string | null } | null)?.display_name
      || (profile as { name: string | null } | null)?.name
      || 'Vendeur';

    notifyEvent({
      businessId,
      eventType: 'sale_completed',
      payload: {
        seller: sellerName,
        desc: describeQueuedCart(cart),
        amount: formatAmount(totalCents / 100, currency),
      },
      targetRoles: ['administrateur', 'manager'],
    });
  } catch {
    // Best-effort — never let a notification lookup failure affect sync.
  }
}

async function executeOp(operation: string, payload: Record<string, unknown>): Promise<void> {
  switch (operation) {
    case 'submit_sale': {
      const { error } = await supabase.rpc('submit_sale', payload);
      if (error) throw error;
      void notifyQueuedSaleSynced(payload);
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
      // Legacy shape: queued by an app version from before record_payment became
      // an RPC (payload has `payments`/`fully_paid_ids` instead of `p_sale_id`
      // etc.). Devices that queued a payment offline on that older build still
      // have rows like this sitting in their local sync_queue. migration_v105
      // dropped the direct client-side INSERT policy on `payments` (record_payment
      // is now the only path in), so these can no longer be replayed with a raw
      // insert — map each legacy row onto the RPC instead, which re-derives
      // fullyPaid itself instead of trusting `fully_paid_ids` computed offline.
      if ('payments' in payload) {
        const { payments } = payload as {
          payments: { order_id: string; business_id: string; amount: number; method: string; date: string }[];
        };
        for (const p of payments) {
          const { error } = await supabase.rpc('record_payment', {
            p_sale_id:     p.order_id,
            p_business_id: p.business_id,
            p_amount:      p.amount,
            p_method:      p.method,
            p_date:        p.date,
          });
          if (error) throw error;
        }
        break;
      }
      // Current shape: replays through the same guarded RPC used online — re-checks
      // the real remaining balance at drain time and throws if it would overpay,
      // instead of blindly inserting whatever the phone computed before going offline.
      const { error } = await supabase.rpc('record_payment', payload);
      if (error) throw error;
      break;
    }
    case 'record_client_payment': {
      const { error } = await supabase.rpc('record_client_payment', payload);
      if (error) throw error;
      break;
    }
    case 'create_product': {
      const { product, stockMove } = payload as {
        product: object;
        stockMove: object | null;
      };
      const { error } = await supabase.rpc('create_product_with_stock', {
        p_product: product,
        p_stock_move: stockMove,
      });
      if (error) throw error;
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
  if (_running) return { synced: 0, failed: 0, rejectedPayments: [] };
  _running = true;

  const result: SyncResult = { synced: 0, failed: 0, rejectedPayments: [] };

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
        // Server/auth/validation error — mark failed, continue with next item.
        // Supabase RPC errors (PostgrestError) are plain objects with a
        // `.message`, not `Error` instances — fall through to that before
        // String(e), which would otherwise stringify them as "[object Object]".
        const msg = e instanceof Error
          ? e.message
          : (e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e));
        await markAttemptFailed(op.id, msg);
        result.failed++;
        if (op.operation === 'record_payment' || op.operation === 'record_client_payment') {
          result.rejectedPayments.push(msg);
        }
      }
    }
  } finally {
    _running = false;
  }

  return result;
}
