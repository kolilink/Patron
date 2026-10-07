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
import { localDateISO } from '@/src/utils/dates';
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
  // The queue item behind this row was refused by the server (failed_permanent).
  // The ventes list keeps showing it (deliberate — nothing she recorded vanishes),
  // but money reports MUST NOT count it: a refused sale is not revenue.
  _failedPermanent?: true;
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
      paid_at: null, sale_date: (payload.p_sale_date as string | null) ?? localDateISO(), due_date: null,
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
      paid_at: now, sale_date: (payload.p_sale_date as string | null) ?? localDateISO(), due_date: null,
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
      sale_date: (payload.p_sale_date as string | null) ?? localDateISO(),
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
export interface PaymentAllocation { saleId: string; amount: number }

// The FIFO split itself (oldest credit sale first), separated from applying it
// so the carnet can show a pending payment as the same per-sale rows the
// server will create.
export function computeAllocations(
  sales: OverlaySale[],
  businessId: string,
  customerName: string,
  amount: number,
): PaymentAllocation[] {
  const creditSales = sales
    .filter(s => s.customer_name === customerName && s.business_id === businessId && s.status === 'credit')
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  let toAllocate = amount;
  const out: PaymentAllocation[] = [];
  for (const sale of creditSales) {
    if (toAllocate <= 0.005) break;
    const owed = sale.total_amount - (sale.discount_amount ?? 0);
    const remaining = owed - (sale.amount_paid ?? 0);
    if (remaining <= 0.005) continue;
    const allocated = Math.min(toAllocate, remaining);
    out.push({ saleId: sale.id, amount: allocated });
    toAllocate -= allocated;
  }
  return out;
}

export function allocateClientPayment(
  sales: OverlaySale[],
  businessId: string,
  customerName: string,
  amount: number,
): OverlaySale[] {
  const updates = new Map<string, { newAmountPaid: number; fullyPaid: boolean }>();
  const now = new Date().toISOString();
  const byId = new Map(sales.map(s => [s.id, s]));
  for (const { saleId, amount: allocated } of computeAllocations(sales, businessId, customerName, amount)) {
    const sale = byId.get(saleId)!;
    const owed = sale.total_amount - (sale.discount_amount ?? 0);
    const newAmountPaid = (sale.amount_paid ?? 0) + allocated;
    updates.set(saleId, { newAmountPaid, fullyPaid: newAmountPaid >= owed - 0.01 });
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

// A payment op still in the outbox, as its own event (a payment patches an
// existing sale's amount_paid, which loses the payment itself — reports and the
// carnet ledger need the individual amount). id = the op's idempotency key.
export interface PendingPaymentEvent {
  id: string;
  operation: 'record_client_payment' | 'record_payment';
  amount: number;            // display units, face value
  queuedAt: string;
  businessId: string;
  customerName: string | null;
  saleId: string | null;
  method: string;
  date: string;              // YYYY-MM-DD she chose (p_date), else the day it was queued
  // Per-sale split against the working set at the moment this op folded in
  // (meaningful when the baseline passed to rebuildPendingOverlay is the synced
  // cache; with a [] baseline only pending credit sales can appear here).
  allocations: PaymentAllocation[];
  failedPermanent: boolean;
}

export interface OverlayResult {
  sales: OverlaySale[];
  corrupt: CorruptStub[];
  payments: PendingPaymentEvent[];
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
  const payments: PendingPaymentEvent[] = [];
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
      if (projected) {
        if (item.status === 'failed_permanent') projected._failedPermanent = true;
        sales = [projected, ...sales];
      }
    } else if (PATCH_OPS.has(item.operation)) {
      let allocations: PaymentAllocation[] = [];
      if (item.operation === 'record_client_payment') {
        allocations = computeAllocations(sales, String(payload.p_business_id ?? ''), String(payload.p_customer_name ?? ''), Number(payload.p_amount ?? 0) / 100);
      } else if (item.operation === 'record_payment') {
        const target = sales.find(x => x.id === String(payload.p_sale_id ?? ''));
        if (target) allocations = [{ saleId: target.id, amount: Number(payload.p_amount ?? 0) / 100 }];
      }
      sales = applyPatchOp(sales, item.operation, payload, item.queued_at, ctx);
      if (item.operation === 'record_client_payment' || item.operation === 'record_payment') {
        const queuedAt = item.queued_at ?? new Date().toISOString();
        payments.push({
          id: item.idempotency_key ?? (payload.p_idempotency_key != null ? String(payload.p_idempotency_key) : `${item.operation}:${item.id}`),
          operation: item.operation,
          amount: Number(payload.p_amount ?? 0) / 100,
          queuedAt,
          method: payload.p_method != null ? String(payload.p_method) : 'especes',
          date: payload.p_date != null ? String(payload.p_date).slice(0, 10) : queuedAt.slice(0, 10),
          allocations,
          businessId: opBusinessId ?? '',
          customerName: payload.p_customer_name != null ? String(payload.p_customer_name) : null,
          saleId: payload.p_sale_id != null ? String(payload.p_sale_id) : null,
          failedPermanent: item.status === 'failed_permanent',
        });
      }
    }
    // Any other queued operation (create_expense, adjust_stock, ...) has no
    // effect on the sales overlay — intentionally a no-op here, not an
    // error; this module only concerns itself with what Phase 1 covers.
  }

  return { sales, corrupt, payments };
}

// ─────────────────────────────────────────────────────────────────────────────
// Report delta — what still-unsynced writes add to a server-computed report.
//
// Read side of offline: a report screen shows `base + delta`, where `base` is
// the last server (or cached) report and `delta` is built here from the
// outbox. Pure: takes the output of rebuildPendingOverlay([], ctx) (so only
// NEW sales and payment events — a baseline of [] means nothing synced is in
// the working set) and a period; never reads the queue itself. Mirrors the
// RPC buckets in db/migration_v162.sql (+ v220's cost rule):
//   revenue    = Σ(total − discount) over paye/credit sales dated in period
//   salesCount = number of those sales        unitsSold = Σ line qty
//   daily      = per sale_date {amount, salesCount, unitsSold}
//   topSellers = per real catalog product {qty, revenue} (is_system
//                placeholders excluded, as get_best_sellers does)
//   creditDelta = pending credit balances (owed − upfront payment), minus every
//                pending payment at FACE VALUE; callers clamp the displayed
//                outstanding at ≥ 0
//   cashDelta   = upfront payments on pending sales + pending payment events
// Profit contribution is ALWAYS 0: a pending row's cost is unknown (the RPC
// looks it up server-side at sync). pendingWithoutCost counts the pending
// sales in period so the screen shows its "sans prix d'achat" caveat
// instead of an invented margin.
//
// Excluded on purpose: status === 'annule' (a pending cancel of a pending sale)
// and _failedPermanent rows/events (a refused sale is not revenue — the ventes
// list still shows it, see lib/db.ts getAllQueueItemsForOverlay).
//
// OUT OF SCOPE (no overlay, the number simply stays at the server value until
// sync): operating_expenses, stock_losses, stock_value, apports/capital — their
// writes aren't in the Phase-1 outbox set. A queued cancellation aimed at an
// ALREADY-SYNCED sale does not subtract that sale's revenue (the sale isn't in
// the working set); a payment aimed at one still moves cash/credit.
//
// MULTI-DEVICE BOUNDARY: this phone's outbox is the only thing it can know. A
// second phone's unsynced sales are unknowable here; they appear after that
// phone syncs and this one next refreshes.
// ─────────────────────────────────────────────────────────────────────────────

export interface DailyDelta { amount: number; salesCount: number; unitsSold: number }
export interface TopSellerDelta { product_id: string; product_name: string; qty: number; revenue: number }
export interface StaffSellerDelta { name: string; revenue: number; count: number }

export interface MyReportDelta {
  revenue: number;
  salesCount: number;
  unitsSold: number;
  creditDelta: number;
  creditCountDelta: number;
  daily: Map<string, DailyDelta>;
  activity: Map<string, number>;
}

export interface ReportDelta {
  revenue: number;
  salesCount: number;
  unitsSold: number;
  creditDelta: number;
  creditCountDelta: number;
  cashDelta: number;
  pendingWithoutCost: number;
  daily: Map<string, DailyDelta>;
  topSellers: Map<string, TopSellerDelta>;
  staffSellers: Map<string, StaffSellerDelta>;
  /** Vendeur view: only rows with seller_id === currentUserId. */
  my: MyReportDelta;
}

export interface ReportDeltaOptions {
  /** Inclusive YYYY-MM-DD bounds of the report period. */
  start: string;
  end: string;
  currentUserId: string | null;
  /** If given, topSellers only includes these product ids (the real catalog). */
  knownProductIds?: Set<string>;
}

const emptyMy = (): MyReportDelta => ({
  revenue: 0, salesCount: 0, unitsSold: 0, creditDelta: 0, creditCountDelta: 0, daily: new Map(), activity: new Map(),
});

export function emptyReportDelta(): ReportDelta {
  return {
    revenue: 0, salesCount: 0, unitsSold: 0, creditDelta: 0, creditCountDelta: 0, cashDelta: 0,
    pendingWithoutCost: 0, daily: new Map(), topSellers: new Map(), staffSellers: new Map(), my: emptyMy(),
  };
}

const saleDay = (s: OverlaySale) => s.sale_date ?? s.created_at.split('T')[0];

function addDaily(map: Map<string, DailyDelta>, day: string, amount: number, units: number) {
  const cur = map.get(day) ?? { amount: 0, salesCount: 0, unitsSold: 0 };
  cur.amount += amount; cur.salesCount += 1; cur.unitsSold += units;
  map.set(day, cur);
}

export function buildReportDelta(
  overlay: { sales: OverlaySale[]; payments?: PendingPaymentEvent[] },
  opts: ReportDeltaOptions,
): ReportDelta {
  const d = emptyReportDelta();
  for (const sale of overlay.sales) {
    if (!sale._pending || sale._failedPermanent) continue;
    if (sale.status !== 'paye' && sale.status !== 'credit') continue; // annule etc.
    const day = saleDay(sale);
    const inPeriod = day >= opts.start && day <= opts.end;
    const net = sale.total_amount - (sale.discount_amount ?? 0);
    const units = (sale.lines ?? []).reduce((sum, l) => sum + l.qty, 0);
    const mine = opts.currentUserId != null && sale.seller_id === opts.currentUserId;

    // Credit / cash are live all-time balances in the RPC (not period-bound).
    // status may have flipped credit → paye through a pending payment patch, so
    // test the creation-time intent (is_credit is never flipped), and take only
    // the UPFRONT payments recorded on the row (patches don't add entries — the
    // payment events below carry those, at face value).
    const upfront = (sale.payments ?? []).reduce((sum, p) => sum + p.amount, 0);
    d.cashDelta += upfront;
    if (sale.is_credit) {
      const balance = Math.max(0, net - upfront);
      d.creditDelta += balance;
      if (balance > 0.005) d.creditCountDelta += 1;
      if (mine) {
        d.my.creditDelta += balance;
        if (balance > 0.005) d.my.creditCountDelta += 1;
      }
    }

    if (!inPeriod) continue;
    d.revenue += net;
    d.salesCount += 1;
    d.unitsSold += units;
    d.pendingWithoutCost += 1; // cost is unknown for every pending sale (v220 rule)
    addDaily(d.daily, day, net, units);

    const staff = d.staffSellers.get(sale.seller_name) ?? { name: sale.seller_name, revenue: 0, count: 0 };
    staff.revenue += net; staff.count += 1;
    d.staffSellers.set(sale.seller_name, staff);

    for (const line of sale.lines ?? []) {
      if (!line.product_id) continue;
      if (opts.knownProductIds && !opts.knownProductIds.has(line.product_id)) continue;
      const cur = d.topSellers.get(line.product_id)
        ?? { product_id: line.product_id, product_name: line.product_name, qty: 0, revenue: 0 };
      cur.qty += line.qty;
      cur.revenue += line.qty * line.unit_price;
      d.topSellers.set(line.product_id, cur);
    }

    if (mine) {
      d.my.revenue += net;
      d.my.salesCount += 1;
      d.my.unitsSold += units;
      addDaily(d.my.daily, day, net, units);
      d.my.activity.set(day, (d.my.activity.get(day) ?? 0) + net);
    }
  }

  for (const p of overlay.payments ?? []) {
    if (p.failedPermanent) continue;
    d.cashDelta += p.amount;
    d.creditDelta -= p.amount; // face value, never allocated: the clamp happens where it is displayed
    // Vendeur: a payment's target sale/seller isn't in the payload, so it is
    // NOT subtracted from my_* credit (it may belong to someone else) — my
    // outstanding can overstate until sync, never understate.
  }
  return d;
}

export interface BestSellerRow {
  product_id: string;
  product_name: string;
  total_qty: number;
  total_revenue: number;
}

/** Home best-sellers: base month ranking + the builder's topSellers → qty ≥ 2, revenue-desc, top 5. */
export function applyTopSellers(base: BestSellerRow[], topSellers: Map<string, TopSellerDelta>): BestSellerRow[] {
  const merged = new Map<string, BestSellerRow>(base.map(b => [b.product_id, { ...b }]));
  for (const t of topSellers.values()) {
    const cur = merged.get(t.product_id);
    if (cur) { cur.total_qty += t.qty; cur.total_revenue += t.revenue; }
    else merged.set(t.product_id, { product_id: t.product_id, product_name: t.product_name, total_qty: t.qty, total_revenue: t.revenue });
  }
  return [...merged.values()]
    .filter(b => b.total_qty >= 2)
    .sort((a, b) => b.total_revenue - a.total_revenue)
    .slice(0, 5);
}

// ─────────────────────────────────────────────────────────────────────────────
// Refused operations (failed_permanent) — surfaced as a notice, never counted.
// ─────────────────────────────────────────────────────────────────────────────

export interface RefusedOp {
  id: number;
  operation: string;
  label: string;        // what she recorded, in her words
  reason: string;       // the server's own (French) refusal message
  queuedAt: string;
  payload: string;      // kept so Réessayer can re-enqueue it unchanged
  idempotencyKey: string | null;
}

const OP_LABELS: Record<string, string> = {
  submit_sale: 'Vente', submit_quick_sale: 'Vente', submit_carnet_debt: 'Crédit',
  record_client_payment: 'Paiement', record_payment: 'Paiement', cancel_sale: 'Annulation', confirm_reception: 'Livraison',
};

export async function loadRefusedOps(currentBusinessId: string | null): Promise<RefusedOp[]> {
  const { ok } = await getAllQueueItemsForOverlay();
  const out: RefusedOp[] = [];
  for (const item of ok) {
    if (item.status !== 'failed_permanent') continue;
    try {
      const payload = JSON.parse(item.payload) as Record<string, unknown>;
      const biz = payload.p_business_id != null ? String(payload.p_business_id) : null;
      if (currentBusinessId && biz && biz !== currentBusinessId) continue;
    } catch { continue; }
    out.push({
      id: item.id, operation: item.operation, label: OP_LABELS[item.operation] ?? 'Opération',
      reason: item.last_error ?? 'Refusée par le serveur', queuedAt: item.queued_at ?? '',
      payload: item.payload, idempotencyKey: item.idempotency_key ?? null,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Carnet: pending payments as ledger rows.
// ─────────────────────────────────────────────────────────────────────────────

export interface PendingLedgerPayment {
  id: string;            // the op's idempotency key (one row per sale a split lands on: key, key#2, …)
  order_id: string;
  method: string;
  amount: number;
  date: string;
  created_at: string;    // queued_at
  _pending: true;
}

/** The ledger rows a client's still-queued payments will become, from rebuildPendingOverlay(cacheBaseline, ctx).payments. */
export function pendingLedgerPayments(payments: PendingPaymentEvent[], clientSaleIds: Set<string>): PendingLedgerPayment[] {
  const rows: PendingLedgerPayment[] = [];
  for (const p of payments) {
    if (p.failedPermanent) continue; // refused: not a payment she received
    let n = 0;
    for (const a of p.allocations) {
      if (!clientSaleIds.has(a.saleId)) continue;
      n += 1;
      rows.push({
        id: n === 1 ? p.id : `${p.id}#${n}`,
        order_id: a.saleId, method: p.method, amount: a.amount, date: p.date, created_at: p.queuedAt, _pending: true,
      });
    }
  }
  return rows;
}
