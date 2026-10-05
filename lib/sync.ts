import * as Sentry from '@sentry/react-native';
import { Platform, type AppStateStatus } from 'react-native';
import { supabase } from '@/lib/supabase';
import { getPendingOpsForDrain, deleteQueueItem, rescheduleOp, markOpPermanentlyFailed, markOpCorrupt } from '@/lib/db';
import { notifyEvent, resolveSellerDisplayName } from '@/src/utils/notifications';
import { formatAmount } from '@/src/utils/format';

// One sync-health signal drainQueue observed — pure data, no side effect.
// Deliberately NOT fired as a trackEvent() call from inside this file:
// lib/sync.ts is foundational and imported by lib/posthog.ts/lib/analytics.ts
// themselves (isNetworkError, APP_STATE_FLAP_GUARD_MS), and by many test
// files that have no reason to know about PostHog. Importing trackEvent
// here was tried and reverted — it transitively runs lib/posthog.ts's
// module-top-level `new PostHog(...)`, which needs AppState and crashed 5
// unrelated test suites the instant they imported this file, whether or
// not they ever called drainQueue. The caller (stores/sync.ts, which
// already safely imports analytics the same way every other store does)
// fires the actual trackEvent calls from these records instead.
export interface SyncHealthEvent {
  name: 'sync_drain_failed_network' | 'sync_op_failed_permanent' | 'sync_op_failed_corrupt';
  businessId: string | null;
  metadata: Record<string, unknown>;
}

export type SyncResult = {
  synced: number;
  failed: number;
  // Payment-specific rejections (e.g. a debt already settled by another queued
  // payment before this one synced) — surfaced separately so the caller can
  // alert the merchant instead of letting them vanish into a silent retry.
  rejectedPayments: string[];
  syncHealthEvents: SyncHealthEvent[];
};

let _running = false;

import { isNetworkError, extractErrorMessage } from '@/lib/networkError';
// Re-exported: callers keep importing isNetworkError from here.
export { isNetworkError };

// A genuine business rejection is a RAISE EXCEPTION with ERRCODE P0001 — this
// codebase's convention for French, user-facing rejections (see CLAUDE.md's
// "Monetary amounts" / RPC notes; every RPC raises its business rules with
// `USING ERRCODE = 'P0001'`). Supabase RPC errors are PostgrestError-shaped
// plain objects carrying the SQLSTATE in `.code`, not thrown `Error` instances
// — so this must read `.code`, not look for a class name. Everything else —
// an HTTP 5xx (service unavailable, gateway timeout), a raw SQLSTATE like a
// foreign-key/permission violation, or any other unexpected failure — is NOT
// a business rejection: it may be transient (a deploy, a blip, a race), so it
// must reschedule with backoff like a network error rather than silently drop
// real, unsynced merchant data forever. Only P0001 is permanent.
export function isBusinessRejection(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err) {
    return String((err as { code: unknown }).code) === 'P0001';
  }
  return false;
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
    timer = setTimeout(() => {
      const err = new Error(`Network timeout after ${ms}ms`) as Error & { stalled?: boolean };
      // Marks OUR timer firing (a request that neither succeeded nor failed),
      // as distinct from a fast rejection — withNetworkRetry must not retry a stall.
      err.stalled = true;
      reject(err);
    }, ms);
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
const RETRY_CONFIRM_TIMEOUT_MS = 3000;
// A first load that neither succeeds nor fails within this window is a
// half-open connection (Wi-Fi up, packets going nowhere), not a slow one:
// treat it as the honest offline state so the cache-fallback path runs and
// the screen stops showing a skeleton. This was 12s + 0.5s + 5s = 17.5s.
// Worst case now: STALL_TIMEOUT_MS (stall, no retry), or a fast failure
// followed by one confirm retry capped at RETRY_CONFIRM_TIMEOUT_MS.
const STALL_TIMEOUT_MS = 5000;

export async function withNetworkRetry<T>(
  fn: () => PromiseLike<T>,
  ms = STALL_TIMEOUT_MS,
  isFailure: (result: T) => boolean = (result) => isNetworkError((result as { error?: unknown } | null)?.error),
): Promise<T> {
  let first: T;
  try {
    first = await withTimeout(fn(), ms);
  } catch (err) {
    if (!isNetworkError(err)) throw err;
    // A stall is not a blip: retrying a half-open connection only doubles the wait.
    if ((err as { stalled?: boolean }).stalled) throw err;
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

// po_received after a queued réception reaches the server — the supplier name is
// looked up best-effort (a failure here must never affect the sync result).
async function notifyReceptionSynced(payload: Record<string, unknown>): Promise<void> {
  try {
    const businessId = payload.p_business_id as string;
    const lines = (payload.p_lines as { qty?: number }[] | undefined) ?? [];
    const totalItems = lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
    let supplier = 'Marché';
    if (payload.p_supplier_id) {
      const { data } = await supabase.from('suppliers').select('name').eq('id', payload.p_supplier_id as string).maybeSingle();
      supplier = (data as { name?: string } | null)?.name ?? '';
    }
    notifyEvent({
      businessId,
      eventType: 'po_received',
      payload: { N: totalItems, supplier },
      targetRoles: ['administrateur', 'manager', 'vendeur'],
    });
  } catch { /* best-effort */ }
}

// The online path (stores/sales.ts) notifies admins/managers right after a
// successful submit_sale call — the offline-queue replay skipped this
// entirely, so sales made offline (this app's core low-connectivity use
// case) never generated the notification once synced. Best-effort: a lookup
// failure here must never affect the sync result itself.
async function notifyQueuedSaleSynced(payload: Record<string, unknown>, saleId: string | null): Promise<void> {
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
        sale_id: saleId,
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
      const { data: saleId, error } = await supabase.rpc('submit_sale', payload);
      if (error) throw error;
      void notifyQueuedSaleSynced(payload, (saleId as string) ?? null);
      break;
    }
    case 'submit_carnet_debt': {
      // No notification hookup needed — the online path (stores/sales.ts)
      // never fires one for a carnet debt either, so there's no parity gap
      // to close here (unlike submit_sale's notifyQueuedSaleSynced above).
      const { error } = await supabase.rpc('submit_carnet_debt', payload);
      if (error) throw error;
      break;
    }
    case 'submit_quick_sale': {
      // Same reasoning as submit_carnet_debt above — the online path
      // (stores/sales.ts) doesn't notify for this either.
      const { error } = await supabase.rpc('submit_quick_sale', payload);
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
            p_sale_id: p.order_id,
            p_business_id: p.business_id,
            p_amount: p.amount,
            p_method: p.method,
            p_date: p.date,
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
    case 'confirm_reception': {
      // A queued réception. The key is also the order id (migration_v229), so a
      // replay returns the same order; po_received notifies the team once, here,
      // at the moment it actually reaches the server.
      const { error } = await supabase.rpc('confirm_reception', payload);
      if (error) throw error;
      void notifyReceptionSynced(payload);
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

// Backoff schedule for a network/5xx failure — exponential with a fixed
// ceiling, then holding there, plus +/-20% jitter so every device that lost
// connectivity to the same outage doesn't retry in the exact same instant
// once it clears. Matches the approved plan's own sequence (5s -> 30s ->
// 2min -> 10min -> 30min); retrying INDEFINITELY past that ceiling — never
// capped — is the entire point of this rework (see the v19 migration's own
// comment on why a hard attempts cap was the wrong design: it silently and
// permanently dropped real, unsynced merchant data after 5 tries).
const BACKOFF_SCHEDULE_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000];

function computeNextAttemptAt(attemptsSoFar: number): string {
  const base = BACKOFF_SCHEDULE_MS[Math.min(attemptsSoFar, BACKOFF_SCHEDULE_MS.length - 1)];
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  const delayMs = Math.max(1000, Math.round(base + jitter));
  return new Date(Date.now() + delayMs).toISOString();
}

// Best-effort, plaintext-only extraction for analytics metadata — every
// Phase-1 RPC payload carries p_business_id, but this must never throw or
// block classification if a payload doesn't have one.
function extractBusinessId(payload: Record<string, unknown> | null): string | null {
  const v = payload?.p_business_id;
  return typeof v === 'string' ? v : null;
}

// §9b: fire-and-forget, durable sync-lag telemetry (migration_v204's
// log_sync_lag) — called once per item that just successfully synced.
// Deliberately its own top-level function, not inlined at the call site:
// wrapping the ENTIRE call (including the act of invoking supabase.rpc
// itself, not just awaiting its result) in a synchronous try/catch is
// what guarantees this can never throw into its caller, even if the call
// itself throws synchronously rather than rejecting (see drainQueue's own
// call site comment for the real bug this specific shape was fixing).
function logSyncLag(operation: string, queuedAt: string | null, payload: Record<string, unknown>): void {
  if (!queuedAt) return;
  const businessId = extractBusinessId(payload);
  if (!businessId) return;
  try {
    supabase.rpc('log_sync_lag', {
      p_business_id: businessId,
      p_operation: operation,
      p_queued_at: queuedAt,
    }).then(
      ({ error }: { error: unknown }) => { if (error) console.error('[logSyncLag] rpc failed', error); },
      (err: unknown) => console.error('[logSyncLag] rpc call rejected', err),
    );
  } catch (err) {
    console.error('[logSyncLag] rpc call threw synchronously', err);
  }
}

export async function drainQueue(): Promise<SyncResult> {
  if (_running) return { synced: 0, failed: 0, rejectedPayments: [], syncHealthEvents: [] };
  _running = true;

  const result: SyncResult = { synced: 0, failed: 0, rejectedPayments: [], syncHealthEvents: [] };

  try {
    const { ok: ops, corrupt } = await getPendingOpsForDrain();

    // Decrypt failures never reach an RPC attempt at all — classify them
    // immediately so a corrupt row stops being silently re-selected (and
    // re-failing decrypt the same way) on every future drain pass, and
    // becomes visible via QueuedOpMeta's plaintext columns instead of
    // invisible. Storage-level bit rot, not a business rejection — reported
    // as its own event, never conflated with sync_op_failed_permanent.
    for (const c of corrupt) {
      await markOpCorrupt(c.id, c.last_error ?? 'decrypt failed');
      result.syncHealthEvents.push({ name: 'sync_op_failed_corrupt', businessId: null, metadata: { operation: c.operation, entity_type: c.entity_type, stage: 'decrypt' } });
    }

    if (ops.length === 0) return result;

    for (const op of ops) {
      let payload: Record<string, unknown> | null = null;
      let justSynced = false;
      try {
        payload = JSON.parse(op.payload) as Record<string, unknown>;
        await executeOp(op.operation, payload);
        await deleteQueueItem(op.id);
        result.synced++;
        justSynced = true;
      } catch (e) {
        if (payload === null) {
          // Decrypted cleanly (it wasn't in `corrupt` above) but the
          // plaintext itself isn't valid JSON — the same storage-level
          // corruption class as a decrypt failure, just caught one step
          // later. Classified identically, never as a business rejection.
          await markOpCorrupt(op.id, extractErrorMessage(e));
          result.syncHealthEvents.push({ name: 'sync_op_failed_corrupt', businessId: null, metadata: { operation: op.operation, stage: 'parse' } });
          result.failed++;
          continue;
        }
        const businessId = extractBusinessId(payload);
        if (isNetworkError(e)) {
          const nextAttemptAt = computeNextAttemptAt(op.attempts);
          await rescheduleOp(op.id, nextAttemptAt, extractErrorMessage(e));
          result.failed++;
          result.syncHealthEvents.push({ name: 'sync_drain_failed_network', businessId, metadata: { operation: op.operation, attempts: op.attempts + 1 } });
          break; // still offline — stop trying the rest of this pass, preserves FIFO ordering
        }
        // Not network-shaped and not a decrypt/parse failure. Only a genuine
        // business rejection — a RAISE EXCEPTION with ERRCODE P0001 (see
        // isBusinessRejection above) — is permanent on the first failure:
        // retrying it would only fail the same way forever. Every other
        // non-network error (HTTP 5xx-shaped like "service unavailable",
        // a raw SQLSTATE such as a foreign-key/permission violation, or any
        // other unexpected failure) may be transient — a deploy, a blip, a
        // race — so it reschedules with backoff exactly like a network
        // error, and the real, unsynced merchant data is never dropped. Only
        // P0001 may carry the label "failed permanently"; 5xx/unexpected is
        // "still retrying, just not immediately."
        const msg = extractErrorMessage(e);
        if (isBusinessRejection(e)) {
          await markOpPermanentlyFailed(op.id, msg);
          result.failed++;
          result.syncHealthEvents.push({ name: 'sync_op_failed_permanent', businessId, metadata: { operation: op.operation, error: msg } });
          if (op.operation === 'record_payment' || op.operation === 'record_client_payment') {
            result.rejectedPayments.push(msg);
          }
        } else {
          // 5xx / unexpected — backoff-reschedule, same as the network branch.
          const nextAttemptAt = computeNextAttemptAt(op.attempts);
          await rescheduleOp(op.id, nextAttemptAt, msg);
          result.failed++;
          result.syncHealthEvents.push({ name: 'sync_drain_failed_network', businessId, metadata: { operation: op.operation, attempts: op.attempts + 1 } });
        }
      }

      // §9b: durable, server-side sync-lag observability (migration_v204's
      // log_sync_lag) — deliberately OUTSIDE the try/catch above, not just
      // wrapped in its own inner try. A first version had this inside that
      // try block, right after result.synced++ — caught by the real jest
      // suite, not reasoned about in advance: a synchronous throw here
      // (e.g. calling .then on a value that isn't a real promise, which is
      // exactly what happened against an exhausted test mock) landed in
      // the SAME catch that classifies real sync failures, permanently
      // mis-marking an item as both synced AND failed. Telemetry must be
      // structurally incapable of reaching that classification logic, not
      // just "unlikely to throw" — this is the fix, not a tighter local
      // try/catch in the same spot. logSyncLag itself is fully self-
      // contained (fire-and-forget, catches everything, including a
      // synchronous throw from the call itself).
      if (justSynced && payload) logSyncLag(op.operation, op.queued_at, payload);
    }
  } catch (err) {
    // drainQueue must never throw outward — it's now routinely invoked
    // fire-and-forget from useSyncStore's kick() (§4), called from every
    // Phase-1 write path right after a local write enqueues. An unhandled
    // rejection out of a fire-and-forget call is a real production risk
    // (this codebase has hit and fixed this exact class of bug more than
    // once — see CLAUDE.md's investor.ts/submitCarnetDebt history), not
    // just a test-mocking convenience. Anything reaching this catch is
    // itself an unexpected failure (getPendingOpsForDrain/deleteQueueItem/
    // etc. throwing for a reason none of the classification branches
    // above anticipated) — logged, not silently dropped, and the queue
    // itself is untouched, so the next drain (foreground, or another kick)
    // simply tries again from the same state.
    console.error('[drainQueue] unexpected top-level failure', err);
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
