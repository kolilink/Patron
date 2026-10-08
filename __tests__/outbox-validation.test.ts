// Outbox payload validation: every operation's contract, enforced inside
// enqueue() BEFORE the SQLite write. Malformed -> throws, nothing written.
// Valid -> stored untouched.

const runAsync = jest.fn(async (..._a: unknown[]) => ({}));
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: async () => ({
    execAsync: async () => {},
    runAsync: (...a: unknown[]) => runAsync(...a),
    getFirstAsync: async () => ({ version: 9999 }),
    getAllAsync: async () => [],
  }),
}));
jest.mock('@/lib/encryption', () => ({ encrypt: async (s: string) => `ENC:${s}`, decrypt: async (s: string) => s }));
const toastShow = jest.fn();
jest.mock('@/stores/toast', () => ({ useToastStore: { getState: () => ({ show: toastShow }) } }));

import { enqueue } from '@/lib/db';
import { OUTBOX_CONTRACTS, OutboxValidationError } from '@/lib/outboxValidation';

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BIZ = U(1), USER = U(2), SALE = U(3), CLIENT = U(4), PROD = U(5), SUP = U(6), KEY = U(7), EXP = U(8);

const valid: Record<string, () => Record<string, any>> = {
  submit_sale: () => ({
    p_business_id: BIZ, p_seller_id: USER, p_customer_name: null, p_sale_date: '2026-10-07',
    p_total_amount: 150000, p_discount_amount: 0, p_is_credit: false,
    p_cart: [{ product_id: PROD, qty: 2, unit_price: 75000, is_bulk: false, product_name: 'Riz', variant_id: null, variant_name: null }],
    p_pay_method: 'especes', p_pay_amount: 150000, p_pay_ref: null, p_idempotency_key: KEY, p_client_id: null,
  }),
  submit_quick_sale: () => ({ p_business_id: BIZ, p_seller_id: USER, p_unit_price: 5000, p_qty: 1, p_label: null, p_idempotency_key: KEY, p_sale_date: '2026-10-07' }),
  submit_carnet_debt: () => ({ p_business_id: BIZ, p_seller_id: USER, p_customer_name: 'Aladji', p_amount: 100000, p_client_id: undefined, p_idempotency_key: KEY, p_sale_date: '2026-10-07' }),
  record_payment: () => ({ p_sale_id: SALE, p_business_id: BIZ, p_amount: 50000, p_method: 'orange', p_date: '2026-10-07', p_idempotency_key: KEY }),
  record_client_payment: () => ({ p_business_id: BIZ, p_customer_name: 'Aladji', p_amount: 50000, p_method: 'especes', p_date: '2026-10-07', p_idempotency_key: KEY }),
  cancel_sale: () => ({ p_sale_id: SALE, p_business_id: BIZ, p_reason: 'Erreur de saisie' }),
  create_expense: () => ({ id: EXP, business_id: BIZ, amount: 20000, description: 'Transport', category: null, date: '2026-10-07', due_date: null, note: null, product_id: null, status: 'en_attente', created_by: USER }),
  update_expense: () => ({ id: EXP, amount: 25000, description: 'Transport', category: null, date: '2026-10-07', due_date: null, note: null, product_id: null }),
  approve_expense: () => ({ id: EXP, status: 'approuve', approved_by: USER, approved_at: '2026-10-07T10:00:00.000Z' }),
  reject_expense: () => ({ id: EXP, status: 'rejete', approved_by: USER, approved_at: '2026-10-07T10:00:00.000Z' }),
  delete_expense: () => ({ p_expense_id: EXP }),
  restore_expense: () => ({ p_expense_id: EXP }),
  create_product: () => ({
    product: { id: PROD, business_id: BIZ, name: 'Riz', category: null, unit: 'pcs', cost_price: 40000, sale_price: 50000, reorder_level: 5, stock_qty: 10, archived: false, supplier_id: null, purchase_date: null, bulk_price: null, bulk_min_qty: null, created_by: USER },
    stockMove: { id: U(9), business_id: BIZ, product_id: PROD, type: 'entree', qty: 10, ref_id: null, ref_type: 'initial', note: 'Stock initial', created_by: USER },
  }),
  update_product: () => ({ id: PROD, name: 'Riz parfumé', sale_price: 60000, cost_price: 40000, bulk_price: null }),
  adjust_stock_move: () => ({ p_business_id: BIZ, p_product_id: PROD, p_type: 'perte', p_qty: 2, p_note: null, p_move_id: U(10) }),
  confirm_reception: () => ({
    p_business_id: BIZ, p_supplier_id: SUP, p_po_id: null,
    p_lines: [{ product_id: PROD, variant_id: null, name: 'Riz', qty: 10, unit_cost_cents: 40000, sale_price_cents: null }],
    p_transport_cost_cents: 0, p_margin_percent: null, p_received_date: null, p_idempotency_key: KEY,
  }),
  pay_supplier_debt: () => ({ p_business_id: BIZ, p_supplier_id: SUP, p_amount_cents: 100000, p_idempotency_key: KEY }),
  create_supplier_debt: () => ({ id: U(11), business_id: BIZ, supplier_id: SUP, amount: 100000, description: null, date: '2026-10-07', amount_paid: 0, created_by: USER }),
};

// Each: [description, mutation]. Mutations edit a fresh valid payload in place.
type Mut = [string, (p: any) => void];
const bad: Record<string, Mut[]> = {
  submit_sale: [
    ['null total', p => { p.p_total_amount = null; }],
    ['negative total', p => { p.p_total_amount = -100; }],
    ['negative discount', p => { p.p_discount_amount = -1; }],
    ['fractional cents', p => { p.p_total_amount = 1500.5; }],
    ['NaN total', p => { p.p_total_amount = NaN; }],
    ['bad business uuid', p => { p.p_business_id = 'biz1'; }],
    ['missing key', p => { delete p.p_idempotency_key; }],
    ['empty cart', p => { p.p_cart = []; }],
    ['zero qty line', p => { p.p_cart[0].qty = 0; }],
    ['negative qty line', p => { p.p_cart[0].qty = -5; }],
    ['bad line product', p => { p.p_cart[0].product_id = 'x'; }],
    ['fractional line price', p => { p.p_cart[0].unit_price = 10.5; }],
    ['unknown pay method', p => { p.p_pay_method = 'wave'; }],
    ['bad date', p => { p.p_sale_date = '2026-13-45'; }],
  ],
  submit_quick_sale: [
    ['zero price (server refuses it)', p => { p.p_unit_price = 0; }],
    ['null price', p => { p.p_unit_price = null; }],
    ['zero qty', p => { p.p_qty = 0; }],
    ['bad seller', p => { p.p_seller_id = ''; }],
    ['missing key', p => { delete p.p_idempotency_key; }],
    ['non-string label', p => { p.p_label = 5; }],
  ],
  submit_carnet_debt: [
    ['empty name', p => { p.p_customer_name = '  '; }],
    ['null amount', p => { p.p_amount = null; }],
    ['negative amount', p => { p.p_amount = -1; }],
    ['null amount', p => { p.p_amount = null; }],
    ['bad client id', p => { p.p_client_id = 'nope'; }],
    ['missing date', p => { delete p.p_sale_date; }],
  ],
  record_payment: [
    ['null amount', p => { p.p_amount = null; }],
    ['zero amount (server refuses it)', p => { p.p_amount = 0; }],
    ['bad sale id', p => { p.p_sale_id = '123'; }],
    ['bad method', p => { p.p_method = 'cheque'; }],
    ['legacy shape', p => { for (const k of Object.keys(p)) delete p[k]; p.payments = []; }],
    ['missing key', p => { delete p.p_idempotency_key; }],
  ],
  record_client_payment: [
    ['empty name', p => { p.p_customer_name = ''; }],
    ['negative amount', p => { p.p_amount = -50; }],
    ['fractional amount', p => { p.p_amount = 12.3; }],
    ['bad date', p => { p.p_date = 'hier'; }],
    ['bad business', p => { p.p_business_id = null; }],
  ],
  cancel_sale: [
    ['bad sale id', p => { p.p_sale_id = 'abc'; }],
    ['missing business', p => { delete p.p_business_id; }],
    ['non-string reason', p => { p.p_reason = 42; }],
  ],
  create_expense: [
    ['null amount', p => { p.amount = null; }],
    ['negative amount', p => { p.amount = -1; }],
    ['empty description', p => { p.description = '  '; }],
    ['bad id', p => { p.id = 'e1'; }],
    ['bad status', p => { p.status = 'paid'; }],
    ['bad date', p => { p.date = '07/10/2026'; }],
    ['bad creator', p => { p.created_by = ''; }],
  ],
  update_expense: [
    ['bad id', p => { p.id = 'e1'; }],
    ['negative amount', p => { p.amount = -1; }],
    ['empty description', p => { p.description = ''; }],
    ['bad date', p => { p.date = 'x'; }],
  ],
  approve_expense: [
    ['wrong status', p => { p.status = 'rejete'; }],
    ['bad approver', p => { p.approved_by = 'me'; }],
    ['bad timestamp', p => { p.approved_at = 'now'; }],
    ['bad id', p => { delete p.id; }],
  ],
  reject_expense: [
    ['wrong status', p => { p.status = 'approuve'; }],
    ['missing approver', p => { delete p.approved_by; }],
    ['bad timestamp', p => { p.approved_at = null; }],
  ],
  delete_expense: [
    ['bad id', p => { p.p_expense_id = 'e1'; }],
    ['missing id', p => { delete p.p_expense_id; }],
  ],
  restore_expense: [
    ['bad id', p => { p.p_expense_id = 5; }],
    ['missing id', p => { delete p.p_expense_id; }],
  ],
  create_product: [
    ['empty name', p => { p.product.name = ' '; }],
    ['negative cost', p => { p.product.cost_price = -1; }],
    ['fractional sale price', p => { p.product.sale_price = 99.5; }],
    ['null sale price', p => { p.product.sale_price = null; }],
    ['negative stock', p => { p.product.stock_qty = -3; }],
    ['bad product id', p => { p.product.id = 'p1'; }],
    ['missing product', p => { delete p.product; }],
    ['stock move zero qty', p => { p.stockMove.qty = 0; }],
    ['stock move bad type', p => { p.stockMove.type = 'ajout'; }],
    ['stock move other product', p => { p.stockMove.product_id = U(99); }],
  ],
  update_product: [
    ['bad id', p => { p.id = 'p1'; }],
    ['empty name', p => { p.name = ''; }],
    ['negative price', p => { p.sale_price = -5; }],
    ['fractional price', p => { p.cost_price = 1.5; }],
  ],
  adjust_stock_move: [
    ['zero qty', p => { p.p_qty = 0; }],
    ['negative qty', p => { p.p_qty = -2; }],
    ['bad type', p => { p.p_type = 'ajout'; }],
    ['bad move id', p => { p.p_move_id = null; }],
    ['bad product', p => { p.p_product_id = 'p'; }],
  ],
  confirm_reception: [
    ['no lines', p => { p.p_lines = []; }],
    ['line empty name', p => { p.p_lines[0].name = ''; }],
    ['line zero qty', p => { p.p_lines[0].qty = 0; }],
    ['line negative cost', p => { p.p_lines[0].unit_cost_cents = -1; }],
    ['line fractional cost', p => { p.p_lines[0].unit_cost_cents = 10.5; }],
    ['line bad product', p => { p.p_lines[0].product_id = 'p'; }],
    ['negative transport', p => { p.p_transport_cost_cents = -1; }],
    ['bad supplier', p => { p.p_supplier_id = 'm'; }],
    ['missing key', p => { delete p.p_idempotency_key; }],
    ['bad received date', p => { p.p_received_date = '2026-02-31'; }],
  ],
  pay_supplier_debt: [
    ['zero amount', p => { p.p_amount_cents = 0; }],
    ['null amount', p => { p.p_amount_cents = null; }],
    ['fractional amount', p => { p.p_amount_cents = 5.5; }],
    ['bad supplier', p => { p.p_supplier_id = 's'; }],
    ['missing key', p => { delete p.p_idempotency_key; }],
  ],
  create_supplier_debt: [
    ['negative amount', p => { p.amount = -1; }],
    ['negative paid', p => { p.amount_paid = -1; }],
    ['bad id', p => { p.id = 'd'; }],
    ['bad supplier', p => { p.supplier_id = null; }],
    ['bad date', p => { p.date = ''; }],
  ],
};

const OPS = Object.keys(valid);
const storedWrites = () => runAsync.mock.calls.filter(c => String(c[0]).includes('INSERT INTO sync_queue'));

beforeEach(() => { runAsync.mockClear(); toastShow.mockClear(); jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());

// Zero is a legitimate amount wherever the server accepts it.
const zeroOk: [string, (p: any) => void][] = [
  ['submit_sale', p => { p.p_total_amount = 0; p.p_pay_amount = 0; p.p_cart[0].unit_price = 0; }],
  ['submit_sale', p => { p.p_customer_name = '   '; }],
  ['submit_carnet_debt', p => { p.p_amount = 0; }],
  ['record_client_payment', p => { p.p_amount = 0; }],
  ['create_expense', p => { p.amount = 0; }],
  ['update_expense', p => { p.amount = 0; }],
  ['create_supplier_debt', p => { p.amount = 0; }],
];

describe('outbox payload validation', () => {
  it.each(zeroOk.map((z, i) => [i, ...z] as const))('zero/blank-where-server-allows #%s %s is accepted', async (_i, op, mutate) => {
    const payload = valid[op]();
    mutate(payload);
    await expect(enqueue(op, payload)).resolves.toBeUndefined();
    expect(storedWrites()).toHaveLength(1);
  });

  it('a validation failure shows exactly one toast', async () => {
    const p = valid.submit_sale();
    p.p_total_amount = -1; p.p_business_id = 'x';
    await expect(enqueue('submit_sale', p)).rejects.toBeInstanceOf(OutboxValidationError);
    expect(toastShow).toHaveBeenCalledTimes(1);
  });

  it('has a valid fixture and rejection cases for every contract', () => {
    expect(OPS.sort()).toEqual(Object.keys(OUTBOX_CONTRACTS).sort());
    expect(Object.keys(bad).sort()).toEqual(OPS.sort());
  });

  describe.each(OPS)('%s', op => {
    it('accepts a valid payload and stores it untouched', async () => {
      const payload = valid[op]();
      await expect(enqueue(op, payload)).resolves.toBeUndefined();
      const writes = storedWrites();
      expect(writes).toHaveLength(1);
      const stored = String(writes[0][1] && (writes[0][1] as unknown[])[1]);
      expect(JSON.parse(stored.replace(/^ENC:/, ''))).toEqual(JSON.parse(JSON.stringify(payload)));
      expect(toastShow).not.toHaveBeenCalled();
    });

    it.each(bad[op])('refuses before any SQLite write: %s', async (_name, mutate) => {
      const payload = valid[op]();
      mutate(payload);
      await expect(enqueue(op, payload)).rejects.toBeInstanceOf(OutboxValidationError);
      expect(runAsync).not.toHaveBeenCalled();
      expect(toastShow).toHaveBeenCalledTimes(1);
    });
  });

  it('refuses non-object payloads', async () => {
    for (const p of [null, undefined, 'x', 5, []] as any[]) {
      await expect(enqueue('cancel_sale', p)).rejects.toBeInstanceOf(OutboxValidationError);
    }
    expect(runAsync).not.toHaveBeenCalled();
  });

  it('refuses unknown and legacy-only operations (adjust_stock)', async () => {
    await expect(enqueue('drop_database', { a: 1 })).rejects.toBeInstanceOf(OutboxValidationError);
    await expect(enqueue('adjust_stock', { stockMove: {}, productUpdate: {} })).rejects.toBeInstanceOf(OutboxValidationError);
    await expect(enqueue('toString', {})).rejects.toBeInstanceOf(OutboxValidationError);
    expect(runAsync).not.toHaveBeenCalled();
  });

  it('reports every problem, not just the first', async () => {
    const p = valid.submit_quick_sale();
    p.p_unit_price = 0; p.p_qty = -1; p.p_seller_id = 'x';
    try { await enqueue('submit_quick_sale', p); throw new Error('should have thrown'); }
    catch (e) { expect((e as OutboxValidationError).problems.length).toBe(3); }
  });
});
