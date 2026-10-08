// Payload contracts for every operation the outbox can hold. Pure and
// dependency-free so lib/db.ts's enqueue() can call it before the SQLite write.
//
// Each contract is derived from the server side that finally consumes the row
// (the RPC signature in db/migration_v*.sql, or the table insert/update in
// lib/sync.ts's executeOp), not from what a component happens to send:
//   submit_sale / submit_quick_sale / submit_carnet_debt  — v215 / v241
//   record_payment (v225) / record_client_payment (v215) / cancel_sale (v218)
//   confirm_reception (v229) / adjust_stock_move + pay_supplier_debt (v243)
//   soft_delete_expense / restore_expense (v234)
// Money is integer cents everywhere (v24).
// Rule: well-formedness only. Negative refused, zero allowed, missing refused —
// except where the SERVER itself rejects zero (quick sale price/qty, record_payment,
// pay_supplier_debt, adjust_stock_move qty, reception/cart line qty), which we mirror.

export class OutboxValidationError extends Error {
  /** French sentence for the vendor: what to DO, not just what failed. */
  public readonly userMessage: string;
  constructor(public readonly operation: string, public readonly problems: string[]) {
    super(`Outbox payload refused for "${operation}": ${problems.join('; ')}`);
    this.name = 'OutboxValidationError';
    this.userMessage = userMessageFor(problems);
  }
}

function userMessageFor(problems: string[]): string {
  if (problems.some(p => /^p_customer_name\b/.test(p))) return 'Ajoutez le nom du client.';
  if (problems.some(p => /^(p_amount|p_amount_cents|p_unit_price|p_total_amount|amount)\b/.test(p))) return 'Entrez un montant valide.';
  return OUTBOX_VALIDATION_USER_MESSAGE;
}

/** Stores use this to skip their own generic failure message: enqueue() has already toasted the specific one. */
export function isOutboxValidationError(e: unknown): e is OutboxValidationError {
  return e instanceof OutboxValidationError;
}

export const OUTBOX_VALIDATION_USER_MESSAGE =
  "Cette opération contient une donnée invalide et n'a pas été enregistrée.";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const PAYMENT_METHODS = ['especes', 'orange', 'mtn', 'moov', 'digital'] as const; // payments_method_check (v7)
export const STOCK_MOVE_TYPES = ['entree', 'sortie', 'perte', 'retour'] as const;       // stock_moves.type check
export const EXPENSE_STATUSES = ['en_attente', 'approuve', 'rejete'] as const;

type Obj = Record<string, unknown>;
type Problems = string[];

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const missing = (v: unknown) => v === undefined || v === null;

function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// ── field checkers: push a problem, never throw ─────────────────────────────
function uuid(p: Problems, o: Obj, k: string, optional = false) {
  const v = o[k];
  if (missing(v)) { if (!optional) p.push(`${k} is required`); return; }
  if (typeof v !== 'string' || !UUID_RE.test(v)) p.push(`${k} is not a valid UUID`);
}
function text(p: Problems, o: Obj, k: string, optional = false) {
  const v = o[k];
  if (missing(v)) { if (!optional) p.push(`${k} is required`); return; }
  if (typeof v !== 'string' || v.trim() === '') p.push(`${k} must be a non-empty string`);
}
/** Free text that may be null/absent/empty but, when present, must be a string. */
function freeText(p: Problems, o: Obj, k: string) {
  const v = o[k];
  if (!missing(v) && typeof v !== 'string') p.push(`${k} must be a string or null`);
}
function date(p: Problems, o: Obj, k: string, optional = false) {
  const v = o[k];
  if (missing(v)) { if (!optional) p.push(`${k} is required`); return; }
  if (typeof v !== 'string' || !isValidDate(v)) p.push(`${k} is not a valid YYYY-MM-DD date`);
}
function timestamp(p: Problems, o: Obj, k: string, optional = false) {
  const v = o[k];
  if (missing(v)) { if (!optional) p.push(`${k} is required`); return; }
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) p.push(`${k} is not a valid timestamp`);
}
/** Integer cents. `min` 1 = strictly positive, 0 = non-negative. */
function cents(p: Problems, o: Obj, k: string, min: 0 | 1, optional = false) {
  const v = o[k];
  if (missing(v)) { if (!optional) p.push(`${k} is required`); return; }
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) { p.push(`${k} must be an integer number of cents`); return; }
  if (v < min) p.push(min === 1 ? `${k} must be positive` : `${k} must not be negative`);
}
/** Quantity: finite number, > 0 (or >= 0). */
function qty(p: Problems, o: Obj, k: string, allowZero = false, optional = false) {
  const v = o[k];
  if (missing(v)) { if (!optional) p.push(`${k} is required`); return; }
  if (typeof v !== 'number' || !Number.isFinite(v)) { p.push(`${k} must be a finite number`); return; }
  if (allowZero ? v < 0 : v <= 0) p.push(allowZero ? `${k} must not be negative` : `${k} must be positive`);
}
function oneOf(p: Problems, o: Obj, k: string, allowed: readonly string[], optional = false) {
  const v = o[k];
  if (missing(v)) { if (!optional) p.push(`${k} is required`); return; }
  if (typeof v !== 'string' || !allowed.includes(v)) p.push(`${k} must be one of ${allowed.join('|')}`);
}
function bool(p: Problems, o: Obj, k: string) {
  if (typeof o[k] !== 'boolean') p.push(`${k} must be a boolean`);
}
function array(p: Problems, o: Obj, k: string): unknown[] | null {
  const v = o[k];
  if (!Array.isArray(v) || v.length === 0) { p.push(`${k} must be a non-empty array`); return null; }
  return v;
}
function prefixed(p: Problems, prefix: string, sub: Problems) {
  for (const s of sub) p.push(`${prefix}${s}`);
}

// ── per-operation contracts ─────────────────────────────────────────────────
type Check = (o: Obj, p: Problems) => void;

const submitSale: Check = (o, p) => {
  uuid(p, o, 'p_business_id'); uuid(p, o, 'p_seller_id');
  freeText(p, o, 'p_customer_name');   // server: nullable text, no content rule
  date(p, o, 'p_sale_date');
  cents(p, o, 'p_total_amount', 0);    // zero is legitimate: sample, gift, 100% discount
  cents(p, o, 'p_discount_amount', 0);
  bool(p, o, 'p_is_credit');
  oneOf(p, o, 'p_pay_method', PAYMENT_METHODS, true);
  cents(p, o, 'p_pay_amount', 0, true);
  freeText(p, o, 'p_pay_ref');
  uuid(p, o, 'p_idempotency_key'); uuid(p, o, 'p_client_id', true);
  date(p, o, 'p_due_date', true);
  const cart = array(p, o, 'p_cart');
  cart?.forEach((line, i) => {
    if (!isObj(line)) { p.push(`p_cart[${i}] must be an object`); return; }
    const lp: Problems = [];
    uuid(lp, line, 'product_id'); uuid(lp, line, 'variant_id', true);
    qty(lp, line, 'qty');
    cents(lp, line, 'unit_price', 0);
    prefixed(p, `p_cart[${i}].`, lp);
  });
};

const submitQuickSale: Check = (o, p) => {
  uuid(p, o, 'p_business_id'); uuid(p, o, 'p_seller_id');
  cents(p, o, 'p_unit_price', 1);
  qty(p, o, 'p_qty');
  freeText(p, o, 'p_label');
  uuid(p, o, 'p_idempotency_key');
  date(p, o, 'p_sale_date');
};

const submitCarnetDebt: Check = (o, p) => {
  uuid(p, o, 'p_business_id'); uuid(p, o, 'p_seller_id');
  text(p, o, 'p_customer_name');
  cents(p, o, 'p_amount', 0);          // submit_carnet_debt has no amount rule; negative still refused
  uuid(p, o, 'p_client_id', true);
  uuid(p, o, 'p_idempotency_key');
  date(p, o, 'p_sale_date');
};

const recordPayment: Check = (o, p) => {
  uuid(p, o, 'p_sale_id'); uuid(p, o, 'p_business_id');
  cents(p, o, 'p_amount', 1);
  oneOf(p, o, 'p_method', PAYMENT_METHODS);
  date(p, o, 'p_date');
  uuid(p, o, 'p_idempotency_key');
};

const recordClientPayment: Check = (o, p) => {
  uuid(p, o, 'p_business_id');
  text(p, o, 'p_customer_name');
  cents(p, o, 'p_amount', 0);          // record_client_payment has no amount rule
  oneOf(p, o, 'p_method', PAYMENT_METHODS);
  date(p, o, 'p_date');
  uuid(p, o, 'p_idempotency_key');
};

const cancelSale: Check = (o, p) => {
  uuid(p, o, 'p_sale_id'); uuid(p, o, 'p_business_id');
  freeText(p, o, 'p_reason');
};

const createExpense: Check = (o, p) => {
  uuid(p, o, 'id'); uuid(p, o, 'business_id'); uuid(p, o, 'created_by');
  cents(p, o, 'amount', 0);            // expenses table has no positivity check
  text(p, o, 'description');
  freeText(p, o, 'category'); freeText(p, o, 'note');
  date(p, o, 'date'); date(p, o, 'due_date', true);
  uuid(p, o, 'product_id', true);
  oneOf(p, o, 'status', EXPENSE_STATUSES);
};

const updateExpense: Check = (o, p) => {
  uuid(p, o, 'id');
  cents(p, o, 'amount', 0, true);
  if (o.description !== undefined) text(p, o, 'description');
  freeText(p, o, 'category'); freeText(p, o, 'note');
  date(p, o, 'date', true); date(p, o, 'due_date', true);
  uuid(p, o, 'product_id', true);
};

const decideExpense = (status: 'approuve' | 'rejete'): Check => (o, p) => {
  uuid(p, o, 'id');
  if (o.status !== status) p.push(`status must be "${status}"`);
  uuid(p, o, 'approved_by');
  timestamp(p, o, 'approved_at');
};

const expenseRef: Check = (o, p) => uuid(p, o, 'p_expense_id');

const createProduct: Check = (o, p) => {
  const product = o.product;
  if (!isObj(product)) { p.push('product must be an object'); }
  else {
    const pp: Problems = [];
    uuid(pp, product, 'id'); uuid(pp, product, 'business_id'); uuid(pp, product, 'created_by');
    text(pp, product, 'name'); text(pp, product, 'unit');
    cents(pp, product, 'cost_price', 0); cents(pp, product, 'sale_price', 0);
    cents(pp, product, 'bulk_price', 0, true);
    qty(pp, product, 'stock_qty', true); qty(pp, product, 'reorder_level', true, true);
    qty(pp, product, 'bulk_min_qty', true, true);
    uuid(pp, product, 'supplier_id', true);
    date(pp, product, 'purchase_date', true);
    freeText(pp, product, 'category');
    prefixed(p, 'product.', pp);
  }
  const move = o.stockMove;
  if (!missing(move)) {
    if (!isObj(move)) { p.push('stockMove must be an object or null'); return; }
    const mp: Problems = [];
    uuid(mp, move, 'id'); uuid(mp, move, 'business_id'); uuid(mp, move, 'product_id'); uuid(mp, move, 'created_by');
    oneOf(mp, move, 'type', STOCK_MOVE_TYPES);
    qty(mp, move, 'qty');
    prefixed(p, 'stockMove.', mp);
    if (isObj(product) && move.product_id !== product.id) p.push('stockMove.product_id must match product.id');
  }
};

const updateProduct: Check = (o, p) => {
  uuid(p, o, 'id');
  if (o.name !== undefined) text(p, o, 'name');
  if (o.unit !== undefined) text(p, o, 'unit');
  cents(p, o, 'cost_price', 0, true); cents(p, o, 'sale_price', 0, true); cents(p, o, 'bulk_price', 0, true);
  qty(p, o, 'reorder_level', true, true); qty(p, o, 'bulk_min_qty', true, true);
  uuid(p, o, 'supplier_id', true);
  date(p, o, 'purchase_date', true);
  freeText(p, o, 'category');
};

const adjustStockMove: Check = (o, p) => {
  uuid(p, o, 'p_business_id'); uuid(p, o, 'p_product_id');
  oneOf(p, o, 'p_type', STOCK_MOVE_TYPES);
  qty(p, o, 'p_qty');
  freeText(p, o, 'p_note');
  uuid(p, o, 'p_move_id');
};

const confirmReception: Check = (o, p) => {
  uuid(p, o, 'p_business_id'); uuid(p, o, 'p_supplier_id', true); uuid(p, o, 'p_po_id', true);
  cents(p, o, 'p_transport_cost_cents', 0);
  if (!missing(o.p_margin_percent) && (typeof o.p_margin_percent !== 'number' || !Number.isFinite(o.p_margin_percent))) {
    p.push('p_margin_percent must be a finite number or null');
  }
  date(p, o, 'p_received_date', true);
  uuid(p, o, 'p_idempotency_key');
  const lines = array(p, o, 'p_lines');
  lines?.forEach((line, i) => {
    if (!isObj(line)) { p.push(`p_lines[${i}] must be an object`); return; }
    const lp: Problems = [];
    uuid(lp, line, 'product_id', true); uuid(lp, line, 'variant_id', true);
    text(lp, line, 'name');
    qty(lp, line, 'qty');
    cents(lp, line, 'unit_cost_cents', 0, true);   // null = "Prix inconnu"
    cents(lp, line, 'sale_price_cents', 0, true);
    prefixed(p, `p_lines[${i}].`, lp);
  });
};

const payDebt: Check = (o, p) => {
  uuid(p, o, 'p_business_id'); uuid(p, o, 'p_supplier_id');
  cents(p, o, 'p_amount_cents', 1);
  uuid(p, o, 'p_idempotency_key');
};

const createSupplierDebt: Check = (o, p) => {
  uuid(p, o, 'id'); uuid(p, o, 'business_id'); uuid(p, o, 'supplier_id'); uuid(p, o, 'created_by');
  cents(p, o, 'amount', 0);
  cents(p, o, 'amount_paid', 0);
  freeText(p, o, 'description');
  date(p, o, 'date');
};

// Absolute-stock overwrite. No store queues it any more (adjustStock uses
// adjust_stock_move) but drain still replays it and RefusedOpsNotice can
// re-enqueue a refused one, so it keeps a real contract.
const adjustStockLegacy: Check = (o, p) => {
  const move = o.stockMove;
  if (!isObj(move)) p.push('stockMove must be an object');
  else {
    const mp: Problems = [];
    uuid(mp, move, 'id'); uuid(mp, move, 'business_id'); uuid(mp, move, 'product_id');
    oneOf(mp, move, 'type', STOCK_MOVE_TYPES);
    const q = move.qty;
    if (typeof q !== 'number' || !Number.isSafeInteger(q) || q <= 0) mp.push('qty must be a positive integer');
    freeText(mp, move, 'ref_type'); freeText(mp, move, 'note');
    prefixed(p, 'stockMove.', mp);
  }
  const upd = o.productUpdate;
  if (!isObj(upd)) p.push('productUpdate must be an object');
  else {
    const up: Problems = [];
    uuid(up, upd, 'id');
    const sq = upd.stock_qty;
    if (typeof sq !== 'number' || !Number.isSafeInteger(sq) || sq < 0) up.push('stock_qty must be a non-negative integer');
    prefixed(p, 'productUpdate.', up);
  }
};

export const OUTBOX_CONTRACTS: Record<string, Check> = {
  submit_sale: submitSale,
  submit_quick_sale: submitQuickSale,
  submit_carnet_debt: submitCarnetDebt,
  record_payment: recordPayment,
  record_client_payment: recordClientPayment,
  cancel_sale: cancelSale,
  create_expense: createExpense,
  update_expense: updateExpense,
  approve_expense: decideExpense('approuve'),
  reject_expense: decideExpense('rejete'),
  delete_expense: expenseRef,
  restore_expense: expenseRef,
  create_product: createProduct,
  update_product: updateProduct,
  adjust_stock_move: adjustStockMove,
  confirm_reception: confirmReception,
  pay_supplier_debt: payDebt,
  create_supplier_debt: createSupplierDebt,
  adjust_stock: adjustStockLegacy,
};

/**
 * Throws OutboxValidationError unless `payload` satisfies the contract of
 * `operation`. An operation with no contract is refused too: if the server side
 * is unknown here, the row cannot be shown to be understood there.
 */
export function validateOutboxPayload(operation: string, payload: unknown): void {
  const contract = Object.prototype.hasOwnProperty.call(OUTBOX_CONTRACTS, operation)
    ? OUTBOX_CONTRACTS[operation]
    : null;
  if (!contract) throw new OutboxValidationError(operation, ['unknown or no-longer-queueable operation']);
  if (!isObj(payload)) throw new OutboxValidationError(operation, ['payload must be an object']);
  const problems: Problems = [];
  contract(payload, problems);
  if (problems.length) throw new OutboxValidationError(operation, problems);
}
