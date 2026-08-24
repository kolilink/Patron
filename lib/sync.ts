import * as Sentry from '@sentry/react-native';
import { Platform, type AppStateStatus } from 'react-native';
import { supabase } from '@/lib/supabase';
import { getPendingOps, deleteQueueItem, markAttemptFailed } from '@/lib/db';
import { notifyEvent, resolveSellerDisplayName } from '@/src/utils/notifications';
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

// Shared by isNetworkError() and reportOfflineFallback() — a raw Error
// instance is the exception, not the rule, in this codebase: by default
// (no .throwOnError()), a failed Supabase call resolves with a plain
// PostgrestError-shaped OBJECT ({ message, code, details, hint }), not a
// thrown Error. String(plainObject) is the literal text "[object Object]",
// not its message — isNetworkError() has always special-cased this (see
// __tests__/offline-resilience.test.ts's regression guard); this used to be
// duplicated ad hoc rather than shared, and reportOfflineFallback() was
// missing the object-shape branch entirely, so every Sentry event for the
// (most common) plain-object case logged "[object Object]" instead of the
// actual message — silently defeating its own purpose.
function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message);
  return String(err);
}

export function isNetworkError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true;
  const msg = extractErrorMessage(err).toLowerCase();
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

// Every store's offline-read-cache fallback (see CLAUDE.md's "Offline read
// caches") only ever recognizes THAT it fell back to cache, never WHY the
// live fetch actually failed — so every real recurrence (a device stuck on
// "Hors ligne" despite a real internet connection) has to be re-diagnosed
// from scratch, by screenshot, every time. Call this at the same call site
// as every existing `if (isNetworkError(err))` branch, right before setting
// `offline: true`, so the raw error + platform land in Sentry instead. This
// is deliberately its own function rather than a side effect bolted onto
// isNetworkError() itself — isNetworkError() is also called inline in a few
// places purely to pick an error message (not to flip an offline flag), and
// those call sites would otherwise generate a Sentry event for a case that
// was never actually a "this store went offline" moment.
export function reportOfflineFallback(context: string, err: unknown): void {
  Sentry.captureMessage('store_offline_fallback', {
    extra: {
      context,
      platform: Platform.OS,
      error: extractErrorMessage(err),
    },
  });
}

// None of the Supabase read calls across the stores have a client-side
// timeout — under some real-world network conditions (a dead/captive wifi
// rather than true airplane mode, certain carrier states) the underlying
// fetch can hang instead of rejecting promptly, so the catch block that
// falls back to the SQLite read cache never runs and `loading` is stuck
// `true` forever, even though the fallback logic itself is correct. Wrap
// the network call with this so it always settles — the message contains
// "timeout", which isNetworkError() above already recognizes, so a timeout
// is treated exactly like any other network failure by every store's
// existing catch/fallback code. 12s is generous for a slow 3G connection
// (this app's core use case) while still guaranteeing the UI never hangs.
export function withTimeout<T>(promise: PromiseLike<T>, ms = 12000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Network timeout after ${ms}ms`)), ms);
  });
  // Without this, every call leaves its setTimeout running for the full
  // `ms` even after the real promise already settled — harmless in the app
  // (just a dangling timer per call) but adds up in tests, where dozens of
  // calls across a suite can leave the Jest worker unable to exit cleanly.
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

// A single failed request on a marginal connection (real Wi-Fi with a
// momentary stumble — see CLAUDE.md's Wi-Fi Assist / OkHttp-fail-fast note
// on why this hits Android far more than iOS) is common and often just
// noise, not a real outage — trusting it as "offline" on the first failure
// alone is what made the read-cache-fallback banner flip on for a blip that
// would have succeeded a second later. This confirms a network failure with
// one quick, cheap retry before treating it as real: a genuine outage will
// still fail the second time; a passing stumble almost never fails twice in
// a row. Takes a thunk (not a bare promise) since retrying means re-running
// the request, not re-awaiting an already-settled one.
//
// Important: this must check the RESOLVED value, not just catch a rejection.
// By default (no .throwOnError()), supabase-js never rejects on a network
// failure — PostgrestBuilder's own executeWithRetry() catches the fetch
// rejection internally and resolves with `{ data: null, error: {...} }`
// instead (see node_modules/@supabase/postgrest-js's PostgrestBuilder.ts).
// A version that only wrapped a try/catch around the call would never
// actually fire for the common case. supabase-js *does* already retry a
// failed GET internally (3x with backoff, since GET/HEAD/OPTIONS are the
// only methods in its own RETRYABLE_METHODS list) — so for a plain
// `.from().select()` read this is a harmless extra safety net on top of an
// already-retried call. For `.rpc()` calls (POST, not in that list — every
// get_period_report/get_reports_snapshot/open_or_get_alpha_conversation
// call in this codebase) and for supabase.auth.getSession() (a separate
// client with its own, different retry behavior), there is no such
// built-in retry at all, and this is the only thing standing between one
// transient blip and the offline banner.
//
// Generic over any result shape with an optional `error` field (which is
// every Supabase response used in this codebase) — but a `Promise.all([...])`
// of several such results doesn't itself have a top-level `.error`, so
// market.ts's fetchPosts passes its own `isFailure` to check the specific
// element that call site actually throws on.
const RETRY_CONFIRM_DELAY_MS = 500;
const RETRY_CONFIRM_TIMEOUT_MS = 5000;

export async function withNetworkRetry<T>(
  fn: () => PromiseLike<T>,
  ms = 12000,
  isFailure: (result: T) => boolean = (result) => isNetworkError((result as { error?: unknown } | null)?.error),
): Promise<T> {
  let first: T;
  try {
    first = await withTimeout(fn(), ms);
  } catch (err) {
    if (!isNetworkError(err)) throw err;
    await new Promise(resolve => setTimeout(resolve, RETRY_CONFIRM_DELAY_MS));
    return await withTimeout(fn(), RETRY_CONFIRM_TIMEOUT_MS);
  }
  if (!isFailure(first)) return first;
  await new Promise(resolve => setTimeout(resolve, RETRY_CONFIRM_DELAY_MS));
  return await withTimeout(fn(), RETRY_CONFIRM_TIMEOUT_MS);
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
    // Net of discount — p_total_amount alone is the catalog total (see
    // "discount_amount convention" in CLAUDE.md), which read as the product's
    // list price instead of what the customer was actually charged.
    const totalCents = ((payload.p_total_amount as number) ?? 0) - ((payload.p_discount_amount as number) ?? 0);

    const [{ data: biz }, sellerName] = await Promise.all([
      supabase.from('businesses').select('currency').eq('id', businessId).maybeSingle(),
      resolveSellerDisplayName(businessId, sellerId),
    ]);

    const currency = (biz as { currency: string } | null)?.currency ?? 'GNF';
    const totalQty = cart.reduce((s, l) => s + l.qty, 0);

    notifyEvent({
      businessId,
      eventType: 'sale_completed',
      payload: {
        seller: sellerName,
        desc: describeQueuedCart(cart),
        amount: formatAmount(totalCents / 100, currency),
        // qty drives singular/plural agreement in the no-seller-name body.
        qty: totalQty,
      },
      // Investisseurs are looped in on every sale too (mirrors the online path).
      targetRoles: ['administrateur', 'manager', 'investisseur'],
      // Same exclusion as the online path (stores/sales.ts) — the seller
      // shouldn't get pushed a notification about their own sale.
      excludeUserId: sellerId,
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

// A real background→foreground cycle takes at least a second. On some
// Android devices AppState 'active'/'background' flaps rapidly and
// repeatedly (dozens of times a second) with nobody touching the phone — a
// known symptom of a Modal's window not matching the main window's
// edge-to-edge treatment (see FormSheet.tsx / CLAUDE.md's "Form sheets —
// Android keyboard flicker"), confirmed live via PostHog session data
// showing exactly this pattern. app/(app)/_layout.tsx's two AppState
// listeners used to react to every single raw transition — reopening a
// realtime channel and re-fetching the business/draining the sync queue
// each time — so a flapping burst kept the JS thread busy reacting to a
// phantom signal instead of responding to real taps, which is what
// actually read as "the app is slow." Routing every raw transition through
// this debounce means a burst of flaps just keeps resetting the timer; the
// real handler only runs once the state has genuinely settled, so it can't
// fire dozens of times a second no matter how much the phone's own
// window-focus reporting is flapping.
export const APP_STATE_FLAP_GUARD_MS = 1000;

// Returns both the debounced listener and a way to cancel any timer still
// pending when the effect that registered it cleans up (e.g. on logout) —
// removing the AppState subscription itself doesn't cancel an
// already-scheduled setTimeout, so without this a stray flap right before
// unmount could still fire the real handler afterwards, against stale state.
export function debounceAppStateHandler(handler: (state: AppStateStatus) => void): {
  onChange: (nextState: AppStateStatus) => void;
  cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    onChange: (nextState) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        handler(nextState);
      }, APP_STATE_FLAP_GUARD_MS);
    },
    cancel: () => {
      if (timer) { clearTimeout(timer); timer = null; }
    },
  };
}
