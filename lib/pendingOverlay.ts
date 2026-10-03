// The offline-first rewrite's "pending overlay" — the mechanism that makes
// a queued-but-not-yet-synced write show up in the carnet/dashboard/ventes
// list instantly and durably, including across a kill+reopen (acceptance
// test #3 of the "never block capture" plan). Deliberately a pure,
// dependency-free reducer, not a piece of state that's incrementally kept
// in sync with the queue: the overlay is always fully recomputed from
// whatever's CURRENTLY in the durable sync_queue outbox (lib/db.ts),
// never patched in place. That's what makes it self-healing across app
// kill, drain success/failure, and a live fetch overwriting the cache
// underneath it — there's no separate "was this already applied" state to
// drift out of sync, because every rebuild starts from the real source of
// truth (the outbox) and nothing else.
//
// Generalizes an ad hoc, pre-existing pattern: stores/sales.ts's submitSale
// offline branch already builds one-off "optimisticSale" objects and
// prepends them into useVentesStore.sales + ventes_cache. That worked for
// the single case it was written for, but two other Phase-1 operations
// (submitCarnetDebt, submitQuickSale) never got the same treatment at all,
// and a payment/cancellation only ever patched in-memory state with no
// durable cache write for record_client_payment specifically — so a kill
// right after any of those left nothing to rebuild from on reopen. This
// module is the one, tested, durable implementation all five Phase-1
// operations route through (see stores/sales.ts / stores/ventes.ts).
import { getAllQueueItemsForOverlay } from '@/lib/db';

// Mirrors stores/ventes.ts's Vente/VenteLigne/VentePayment shapes exactly
// (display-unit amounts, not cents) — duplicated here rather than imported
// to keep this module dependency-free of the store (a store importing this
// module, which imports the store back, would be a cycle). The two shapes
// must be kept in sync by hand; __tests__/pending-overlay.test.ts asserts
// against the same field set stores/ventes.ts's Vente declares.
export interface OverlayLine {
  id: string;
  product_id: string;
  product_name: string;
  variant_id?: string | null;
  variant_name?: string | null;
  qty: number;
  unit_price: number;
  is_bulk: boolean;
  cost_price: number;
}

export interface OverlayPayment {
  id: string;
  method: string;
  amount: number;
  date: string;
}

export interface OverlaySale {
  id: string;
  business_id: string;
  customer_name: string | null;
  client_id: string | null;
  seller_id: string;
  seller_name: string;
  status: string;
  is_credit: boolean;
  total_amount: number;
  discount_amount: number;
  amount_paid: number;
  paid_at: string | null;
  sale_date: string | null;
  due_date: string | null;
  created_at: string;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  cancelled_by_id: string | null;
  cancelled_by_name: string | null;
  edit_count: number;
  last_edited_at: string | null;
  profit: number | null;
  lines: OverlayLine[];
  payments: OverlayPayment[];
  // Set (true) only on a row this module created or patched from a still-
  // pending queue item — absent/undefined on genuine baseline (synced)
  // data passed into rebuildPendingOverlay. Lets a caller distinguish
  // "still pending" from real synced data without a separate lookup.
  // Never rendered as a badge (the standing "zero sync noise" rule) —
  // purely a data-layer flag for merge/dedup logic (see
  // stores/ventes.ts's refreshPendingOverlay, which strips it back out
  // before every rebuild so a previous overlay is never folded twice).
  _pending?: true;
}

export interface OverlayContext {
  // Resolved by the caller (stores/ventes.ts has useAuthStore access; this
  // module deliberately doesn't import it) — used only when a projected
  // row's seller/canceller is the CURRENT device's logged-in user, which is
  // the only case a rebuild can ever legitimately know: a device's own
  // local outbox only ever holds writes made from that device, under
  // whoever was logged in at the time.
  currentUserId: string | null;
  currentUserName: string;
  // The active business the caller is currently viewing. Threaded in so the
  // rebuild can skip queue items whose p_business_id belongs to a different
  // business — a device switching businesses mid-drain must never leak one
  // business's pending sales/payments into another business's list.
  currentBusinessId: string | null;
}

const NEW_SALE_OPS = new Set(['submit_carnet_debt', 'submit_quick_sale', 'submit_sale']);
const PATCH_OPS = new Set(['cancel_sale', 'record_client_payment', 'record_payment']);

type RawCartLine = {
  product_id: string; product_name: string; qty: number; unit_price: number;
  is_bulk?: boolean; variant_id?: string | null; variant_name?: string | null;
};

// Projects one queued RPC call into a full OverlaySale — used both here
// (cold-start rebuild, cost_price unknown, defaults to 0 — the RPC payload
// never carries it, submit_sale looks it up server-side) and, with an
// enrichment pass applied afterward, by the write-time optimistic-insert
// path in §5 (real cart data available in that moment, so real cost_price
// can be filled in). Returns null for anything that isn't a "creates a new
// sale" operation — cancel_sale/record_client_payment are patches, handled
// by applyPatchOp below, not here.
export function projectNewSale(
  operation: string,
  payload: Record<string, unknown>,
  queuedAt: string | null,
  ctx: OverlayContext,
  idempotencyKey: string,
): OverlaySale | null {
  const businessId = String(payload.p_business_id ?? '');
  const sellerId = String(payload.p_seller_id ?? '');
  const sellerName = ctx.currentUserId && sellerId === ctx.currentUserId ? ctx.currentUserName : '';
  const now = queuedAt ?? new Date().toISOString();

  if (operation === 'submit_carnet_debt') {
    const amount = Number(payload.p_amount ?? 0) / 100;
    return {
      id: idempotencyKey, business_id: businessId,
      customer_name: (payload.p_customer_name as string | null) ?? null,
      client_id: (payload.p_client_id as string | null) ?? null,
      seller_id: sellerId, seller_name: sellerName,
      status: 'credit', is_credit: true,
      total_amount: amount, discount_amount: 0, amount_paid: 0,
      paid_at: null, sale_date: now.slice(0, 10), due_date: null,
      created_at: now, cancelled_at: null, cancellation_reason: null,
      cancelled_by_id: null, cancelled_by_name: null,
      edit_count: 0, last_edited_at: null, profit: null,
      // Carnet debts always post against the hidden "Solde reporté"
      // placeholder server-side (submit_carnet_debt) — no real product line
      // exists to reconstruct, so this mirrors what the synced row will
      // actually look like rather than inventing a fake line.
      lines: [], payments: [],
      _pending: true,
    };
  }

  if (operation === 'submit_quick_sale') {
    const unitPrice = Number(payload.p_unit_price ?? 0) / 100;
    const qty = Number(payload.p_qty ?? 1);
    const total = unitPrice * qty;
    const label = (payload.p_label as string | null) ?? null;
    return {
      id: idempotencyKey, business_id: businessId,
      customer_name: null, client_id: null,
      seller_id: sellerId, seller_name: sellerName,
      status: 'paye', is_credit: false,
      total_amount: total, discount_amount: 0, amount_paid: total,
      paid_at: now, sale_date: now.slice(0, 10), due_date: null,
      created_at: now, cancelled_at: null, cancellation_reason: null,
      cancelled_by_id: null, cancelled_by_name: null,
      edit_count: 0, last_edited_at: null, profit: null,
      lines: [{
        id: generatePlaceholderId(idempotencyKey, 0),
        product_id: '', product_name: label ?? 'Vente rapide',
        qty, unit_price: unitPrice, is_bulk: false, cost_price: 0,
      }],
      payments: [{ id: generatePlaceholderId(idempotencyKey, 1), method: 'especes', amount: total, date: now }],
      _pending: true,
    };
  }

  if (operation === 'submit_sale') {
    const cart = (payload.p_cart as RawCartLine[] | undefined) ?? [];
    const totalAmount = Number(payload.p_total_amount ?? 0) / 100;
    const discountAmount = Number(payload.p_discount_amount ?? 0) / 100;
    const isCredit = Boolean(payload.p_is_credit);
    const payAmount = payload.p_pay_amount != null ? Number(payload.p_pay_amount) / 100 : 0;
    const payMethod = (payload.p_pay_method as string | null) ?? null;
    return {
      id: idempotencyKey, business_id: businessId,
      customer_name: (payload.p_customer_name as string | null) ?? null,
      client_id: (payload.p_client_id as string | null) ?? null,
      seller_id: sellerId, seller_name: sellerName,
      status: isCredit ? 'credit' : 'paye', is_credit: isCredit,
      total_amount: totalAmount, discount_amount: discountAmount, amount_paid: payAmount,
      paid_at: isCredit ? null : now,
      sale_date: (payload.p_sale_date as string | null) ?? now.slice(0, 10),
      due_date: (payload.p_due_date as string | null) ?? null,
      created_at: now, cancelled_at: null, cancellation_reason: null,
      cancelled_by_id: null, cancelled_by_name: null,
      edit_count: 0, last_edited_at: null, profit: null,
      lines: cart.map((l, i) => ({
        id: generatePlaceholderId(idempotencyKey, i),
        product_id: l.product_id, product_name: l.product_name,
        qty: l.qty, unit_price: l.unit_price / 100,
        is_bulk: l.is_bulk ?? false, cost_price: 0,
        variant_id: l.variant_id ?? null, variant_name: l.variant_name ?? null,
      })),
      payments: payMethod ? [{ id: generatePlaceholderId(idempotencyKey, cart.length), method: payMethod, amount: payAmount, date: now }] : [],
      _pending: true,
    };
  }

  return null;
}

// Deterministic (not random) so re-running projectNewSale against the same
// payload — which happens on every overlay rebuild — always produces the
// same line/payment ids instead of new ones each time, which would defeat
// any downstream key-based rendering (React list keys, dedup by id).
function generatePlaceholderId(idempotencyKey: string, index: number): string {
  return `${idempotencyKey}:${index}`;
}

// cancel_sale and record_client_payment mutate EXISTING sales rather than
// creating new ones — applied against whatever `sales` array is being
// folded (the cache baseline plus every earlier pending op already applied
// in queue order). record_client_payment's FIFO allocation is the exact
// logic stores/ventes.ts's own recordClientPayment uses online — extracted
// here as the one shared implementation so the live store and this offline
// rebuild can never drift apart on "how does a payment allocate."
export function applyPatchOp(
  sales: OverlaySale[],
  operation: string,
  payload: Record<string, unknown>,
  queuedAt: string | null,
  ctx: OverlayContext,
): OverlaySale[] {
  if (operation === 'cancel_sale') {
    const saleId = String(payload.p_sale_id ?? '');
    const reason = (payload.p_reason as string | null) ?? null;
    const now = queuedAt ?? new Date().toISOString();
    return sales.map(s => s.id === saleId ? {
      ...s,
      status: 'annule',
      cancelled_at: now,
      cancellation_reason: reason,
      cancelled_by_id: ctx.currentUserId,
      cancelled_by_name: ctx.currentUserId ? ctx.currentUserName : null,
    } : s);
  }

  if (operation === 'record_client_payment') {
    const businessId = String(payload.p_business_id ?? '');
    const customerName = String(payload.p_customer_name ?? '');
    const amount = Number(payload.p_amount ?? 0) / 100;
    return allocateClientPayment(sales, businessId, customerName, amount);
  }

  // record_payment (singular) — a payment against ONE already-known
  // sale_id, unlike record_client_payment's FIFO fan-out across every
  // credit sale for a customer name. No allocation logic needed: just add
  // this payment's amount onto that one sale's amount_paid.
  if (operation === 'record_payment') {
    const saleId = String(payload.p_sale_id ?? '');
    const amount = Number(payload.p_amount ?? 0) / 100;
    const now = queuedAt ?? new Date().toISOString();
    return sales.map(s => {
      if (s.id !== saleId) return s;
      const owed = s.total_amount - (s.discount_amount ?? 0);
      const newAmountPaid = (s.amount_paid ?? 0) + amount;
      const fullyPaid = newAmountPaid >= owed - 0.01;
      return {
        ...s,
        amount_paid: newAmountPaid,
        status: fullyPaid ? 'paye' : s.status,
        paid_at: fullyPaid ? now : s.paid_at,
      };
    });
  }

  return sales;
}

// FIFO allocation — oldest credit sale first — mirrored exactly from
// stores/ventes.ts's recordClientPayment. Pure: takes and returns a plain
// array, no store/network access, so it's usable identically from the live
// action (§5) and this offline rebuild.
export function allocateClientPayment(
  sales: OverlaySale[],
  businessId: string,
  customerName: string,
  amount: number,
): OverlaySale[] {
  const creditSales = sales
    .filter(s => s.customer_name === customerName && s.business_id === businessId && s.status === 'credit')
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  let toAllocate = amount;
  const updates = new Map<string, { newAmountPaid: number; fullyPaid: boolean }>();
  const now = new Date().toISOString();
  for (const sale of creditSales) {
    if (toAllocate <= 0.005) break;
    const owed = sale.total_amount - (sale.discount_amount ?? 0);
    const remaining = owed - (sale.amount_paid ?? 0);
    if (remaining <= 0.005) continue;
    const allocated = Math.min(toAllocate, remaining);
    const newAmountPaid = (sale.amount_paid ?? 0) + allocated;
    updates.set(sale.id, { newAmountPaid, fullyPaid: newAmountPaid >= owed - 0.01 });
    toAllocate -= allocated;
  }

  return sales.map(s => {
    const upd = updates.get(s.id);
    if (!upd) return s;
    return {
      ...s,
      amount_paid: upd.newAmountPaid,
      status: upd.fullyPaid ? 'paye' : s.status,
      paid_at: upd.fullyPaid ? now : s.paid_at,
    };
  });
}

export interface CorruptStub {
  id: number;
  entityType: string | null;
  queuedAt: string | null;
}

export interface OverlayResult {
  sales: OverlaySale[];
  corrupt: CorruptStub[];
}

// The one entry point everything else (stores/ventes.ts §6, the future
// Paramètres line §8) calls. Reads the CURRENT outbox fresh every time —
// see the module header for why that, not incremental patching, is what
// makes this durable across a kill and self-healing against a cache
// overwrite. Folds every non-corrupt op onto `baseline` in queue order
// (id ASC, i.e. the same order the drainer will eventually replay them
// in), so a payment queued after its own credit sale sees that sale
// already in the working set, exactly as it will once both actually sync.
export async function rebuildPendingOverlay(baseline: OverlaySale[], ctx: OverlayContext): Promise<OverlayResult> {
  const { ok, corrupt: decryptCorrupt } = await getAllQueueItemsForOverlay();

  // decrypt-failed rows (already-corrupt, from getAllQueueItemsForOverlay)
  // and JSON.parse-failed rows (decrypted fine, but the plaintext itself
  // isn't valid JSON — a narrower, separately-possible corruption) are
  // combined into one CorruptStub list; both are reported identically to a
  // caller, since the distinction ("which exact step failed") only matters
  // for lib/sync.ts's own PostHog event in §3, not for this overlay's
  // consumers.
  const corrupt: CorruptStub[] = decryptCorrupt.map(c => ({ id: c.id, entityType: c.entity_type, queuedAt: c.queued_at }));

  let sales = baseline;
  for (const item of ok) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(item.payload) as Record<string, unknown>;
    } catch {
      corrupt.push({ id: item.id, entityType: item.entity_type, queuedAt: item.queued_at });
      continue;
    }

    // Business-scope guard (P1-1): a queued op for a DIFFERENT business than
    // the one currently being viewed must never fold into this business's
    // overlay — neither as a new-sale projection nor as a patch. This also
    // keeps a still-queued payment against one business's sale from being
    // allocated against a same-named customer in another business.
    const opBusinessId = payload.p_business_id != null ? String(payload.p_business_id) : null;
    if (ctx.currentBusinessId && opBusinessId && opBusinessId !== ctx.currentBusinessId) {
      continue;
    }

    if (NEW_SALE_OPS.has(item.operation)) {
      const key = item.idempotency_key ?? `${item.operation}:${item.id}`;
      const projected = projectNewSale(item.operation, payload, item.queued_at, ctx, key);
      if (projected) sales = [projected, ...sales];
    } else if (PATCH_OPS.has(item.operation)) {
      sales = applyPatchOp(sales, item.operation, payload, item.queued_at, ctx);
    }
    // Any other queued operation (create_expense, adjust_stock, ...) has no
    // effect on the sales overlay — intentionally a no-op here, not an
    // error; this module only concerns itself with what Phase 1 covers.
  }

  return { sales, corrupt };
}
