// §2 of the offline-first rewrite: lib/pendingOverlay.ts is what makes a
// queued-but-unsynced write show up in the carnet/dashboard instantly and
// durably. These tests exercise the money-safety-relevant logic directly —
// cents-to-display-unit conversion, FIFO payment allocation, and that a
// corrupt queue row never crashes the fold or silently drops the rest of
// the queue.

jest.mock('@/lib/db', () => ({
  getAllQueueItemsForOverlay: jest.fn(),
}));

import { getAllQueueItemsForOverlay } from '@/lib/db';
import {
  projectNewSale,
  applyPatchOp,
  allocateClientPayment,
  rebuildPendingOverlay,
  type OverlaySale,
  type OverlayContext,
} from '@/lib/pendingOverlay';

const ctx: OverlayContext = { currentUserId: 'user-1', currentUserName: 'Fatou' };

function baseSale(overrides: Partial<OverlaySale> = {}): OverlaySale {
  return {
    id: 'sale-1', business_id: 'biz-1', customer_name: 'Aissatou', client_id: null,
    seller_id: 'user-1', seller_name: 'Fatou', status: 'credit', is_credit: true,
    total_amount: 10000, discount_amount: 0, amount_paid: 0,
    paid_at: null, sale_date: '2026-09-28', due_date: null,
    created_at: '2026-09-28T10:00:00.000Z', cancelled_at: null, cancellation_reason: null,
    cancelled_by_id: null, cancelled_by_name: null,
    edit_count: 0, last_edited_at: null, profit: null,
    lines: [], payments: [], _pending: true,
    ...overrides,
  };
}

describe('projectNewSale', () => {
  test('submit_carnet_debt: cents -> display units, status=credit, no lines (Solde reporté placeholder is server-side)', () => {
    const s = projectNewSale('submit_carnet_debt', {
      p_business_id: 'biz-1', p_seller_id: 'user-1', p_customer_name: 'Aissatou',
      p_amount: 500000, p_client_id: 'client-9',
    }, '2026-09-28T10:00:00.000Z', ctx, 'idem-1');
    expect(s).not.toBeNull();
    expect(s!.total_amount).toBe(5000); // 500000 cents -> 5000 GNF
    expect(s!.status).toBe('credit');
    expect(s!.is_credit).toBe(true);
    expect(s!.amount_paid).toBe(0);
    expect(s!.customer_name).toBe('Aissatou');
    expect(s!.client_id).toBe('client-9');
    expect(s!.seller_name).toBe('Fatou'); // currentUserId matches p_seller_id
    expect(s!.lines).toEqual([]);
  });

  test('submit_quick_sale: total = unit_price * qty, always paid in full, especes', () => {
    const s = projectNewSale('submit_quick_sale', {
      p_business_id: 'biz-1', p_seller_id: 'user-1', p_unit_price: 150000, p_qty: 3, p_label: 'Riz',
    }, '2026-09-28T11:00:00.000Z', ctx, 'idem-2');
    expect(s!.total_amount).toBe(4500); // 3 * 1500
    expect(s!.status).toBe('paye');
    expect(s!.amount_paid).toBe(4500);
    expect(s!.lines).toHaveLength(1);
    expect(s!.lines[0].product_name).toBe('Riz');
    expect(s!.lines[0].qty).toBe(3);
    expect(s!.payments).toHaveLength(1);
    expect(s!.payments[0].amount).toBe(4500);
  });

  test('submit_sale: net total/discount, cart lines converted from cents, credit vs paid derived from p_is_credit', () => {
    const s = projectNewSale('submit_sale', {
      p_business_id: 'biz-1', p_seller_id: 'user-1', p_customer_name: null,
      p_total_amount: 1000000, p_discount_amount: 100000, p_is_credit: false,
      p_pay_method: 'especes', p_pay_amount: 900000,
      p_cart: [
        { product_id: 'p1', product_name: 'Sac de riz', qty: 2, unit_price: 500000, is_bulk: false },
      ],
    }, '2026-09-28T12:00:00.000Z', ctx, 'idem-3');
    expect(s!.total_amount).toBe(10000);
    expect(s!.discount_amount).toBe(1000);
    expect(s!.amount_paid).toBe(9000);
    expect(s!.status).toBe('paye');
    expect(s!.lines[0].unit_price).toBe(5000);
    expect(s!.lines[0].qty).toBe(2);
  });

  test('unrelated operation (create_expense) returns null, not a malformed sale', () => {
    expect(projectNewSale('create_expense', {}, null, ctx, 'idem-4')).toBeNull();
  });

  test('id is deterministic across repeated calls with the same idempotency key (rebuild-stable, no drift on re-render)', () => {
    const payload = { p_business_id: 'biz-1', p_seller_id: 'user-1', p_amount: 100000, p_customer_name: 'X' };
    const a = projectNewSale('submit_carnet_debt', payload, '2026-09-28T10:00:00.000Z', ctx, 'idem-5');
    const b = projectNewSale('submit_carnet_debt', payload, '2026-09-28T10:00:00.000Z', ctx, 'idem-5');
    expect(a!.id).toBe(b!.id);
    expect(a!.id).toBe('idem-5');
  });
});

describe('applyPatchOp — cancel_sale', () => {
  test('patches the matching sale only, leaves others untouched', () => {
    const sales = [baseSale({ id: 'a' }), baseSale({ id: 'b' })];
    const patched = applyPatchOp(sales, 'cancel_sale', { p_sale_id: 'a', p_reason: 'Erreur de saisie' }, '2026-09-28T13:00:00.000Z', ctx);
    expect(patched.find(s => s.id === 'a')!.status).toBe('annule');
    expect(patched.find(s => s.id === 'a')!.cancellation_reason).toBe('Erreur de saisie');
    expect(patched.find(s => s.id === 'a')!.cancelled_by_id).toBe('user-1');
    expect(patched.find(s => s.id === 'b')!.status).toBe('credit'); // unchanged
  });

  test('a sale id with no match is a no-op, not a crash', () => {
    const sales = [baseSale({ id: 'a' })];
    const patched = applyPatchOp(sales, 'cancel_sale', { p_sale_id: 'does-not-exist' }, null, ctx);
    expect(patched).toEqual(sales);
  });
});

describe('applyPatchOp — record_payment (single sale, not FIFO)', () => {
  test('a full payment against one sale settles only that sale, leaves others untouched', () => {
    const sales = [
      baseSale({ id: 'a', total_amount: 10000, amount_paid: 0 }),
      baseSale({ id: 'b', total_amount: 5000, amount_paid: 0 }),
    ];
    const patched = applyPatchOp(sales, 'record_payment', { p_sale_id: 'a', p_amount: 1000000 }, '2026-09-28T13:00:00.000Z', ctx);
    expect(patched.find(s => s.id === 'a')!.amount_paid).toBe(10000);
    expect(patched.find(s => s.id === 'a')!.status).toBe('paye');
    expect(patched.find(s => s.id === 'b')!.amount_paid).toBe(0); // unrelated sale untouched
  });

  test('a partial payment stays credit, amount_paid increases by exactly the paid amount', () => {
    const sales = [baseSale({ id: 'a', total_amount: 10000, amount_paid: 2000 })];
    const patched = applyPatchOp(sales, 'record_payment', { p_sale_id: 'a', p_amount: 300000 }, null, ctx);
    expect(patched[0].amount_paid).toBe(5000);
    expect(patched[0].status).toBe('credit');
  });

  test('a sale id with no match is a no-op, not a crash', () => {
    const sales = [baseSale({ id: 'a' })];
    const patched = applyPatchOp(sales, 'record_payment', { p_sale_id: 'does-not-exist', p_amount: 100000 }, null, ctx);
    expect(patched).toEqual(sales);
  });
});

describe('allocateClientPayment — FIFO, the money-safety-critical path', () => {
  test('single sale, exact payment: fully settles', () => {
    const sales = [baseSale({ id: 'a', total_amount: 10000, amount_paid: 0 })];
    const out = allocateClientPayment(sales, 'biz-1', 'Aissatou', 10000);
    expect(out[0].amount_paid).toBe(10000);
    expect(out[0].status).toBe('paye');
  });

  test('single sale, partial payment: stays credit, amount_paid increases', () => {
    const sales = [baseSale({ id: 'a', total_amount: 10000, amount_paid: 2000 })];
    const out = allocateClientPayment(sales, 'biz-1', 'Aissatou', 3000);
    expect(out[0].amount_paid).toBe(5000);
    expect(out[0].status).toBe('credit');
  });

  test('two credit sales, oldest first: payment settles the older one before touching the newer', () => {
    const older = baseSale({ id: 'old', total_amount: 5000, amount_paid: 0, created_at: '2026-09-01T00:00:00.000Z' });
    const newer = baseSale({ id: 'new', total_amount: 5000, amount_paid: 0, created_at: '2026-09-20T00:00:00.000Z' });
    const out = allocateClientPayment([newer, older], 'biz-1', 'Aissatou', 7000);
    const outOlder = out.find(s => s.id === 'old')!;
    const outNewer = out.find(s => s.id === 'new')!;
    expect(outOlder.amount_paid).toBe(5000);
    expect(outOlder.status).toBe('paye');
    expect(outNewer.amount_paid).toBe(2000); // remaining 2000 spills into the newer sale
    expect(outNewer.status).toBe('credit');
  });

  test('payment exceeding total owed never over-allocates past what is owed (no money invented)', () => {
    const sales = [baseSale({ id: 'a', total_amount: 5000, amount_paid: 0 })];
    const out = allocateClientPayment(sales, 'biz-1', 'Aissatou', 999999);
    expect(out[0].amount_paid).toBe(5000); // capped at what was actually owed
  });

  test('only matches the given customer+business — a same-named customer in a different business is untouched', () => {
    const sales = [
      baseSale({ id: 'a', business_id: 'biz-1', total_amount: 5000, amount_paid: 0 }),
      baseSale({ id: 'b', business_id: 'biz-2', customer_name: 'Aissatou', total_amount: 5000, amount_paid: 0 }),
    ];
    const out = allocateClientPayment(sales, 'biz-1', 'Aissatou', 5000);
    expect(out.find(s => s.id === 'a')!.amount_paid).toBe(5000);
    expect(out.find(s => s.id === 'b')!.amount_paid).toBe(0); // different business, never touched
  });

  test('already-paid (non-credit) sales are never touched by allocation', () => {
    const sales = [baseSale({ id: 'a', status: 'paye', total_amount: 5000, amount_paid: 5000 })];
    const out = allocateClientPayment(sales, 'biz-1', 'Aissatou', 5000);
    expect(out[0].amount_paid).toBe(5000); // untouched, not double-paid
  });
});

describe('rebuildPendingOverlay — the full fold, in queue order', () => {
  const mockGetAll = getAllQueueItemsForOverlay as jest.Mock;

  test('a credit sale queued, then a payment against it queued after: the payment finds the credit sale already in the working set', async () => {
    mockGetAll.mockResolvedValue({
      ok: [
        {
          id: 1, operation: 'submit_carnet_debt', status: 'pending', attempts: 0, last_error: null,
          idempotency_key: 'debt-1', entity_type: 'dette', queued_at: '2026-09-28T10:00:00.000Z', created_at: '2026-09-28T10:00:00.000Z',
          payload: JSON.stringify({ p_business_id: 'biz-1', p_seller_id: 'user-1', p_customer_name: 'Aissatou', p_amount: 1000000 }),
        },
        {
          id: 2, operation: 'record_client_payment', status: 'pending', attempts: 0, last_error: null,
          idempotency_key: null, entity_type: 'paiement', queued_at: '2026-09-28T10:05:00.000Z', created_at: '2026-09-28T10:05:00.000Z',
          payload: JSON.stringify({ p_business_id: 'biz-1', p_customer_name: 'Aissatou', p_amount: 1000000, p_method: 'especes', p_date: '2026-09-28' }),
        },
      ],
      corrupt: [],
    });

    const result = await rebuildPendingOverlay([], ctx);
    expect(result.sales).toHaveLength(1);
    expect(result.sales[0].id).toBe('debt-1');
    expect(result.sales[0].amount_paid).toBe(10000); // the payment already applied, fully settling it
    expect(result.sales[0].status).toBe('paye');
    expect(result.corrupt).toEqual([]);
  });

  test('a corrupt row is reported and skipped, without dropping or crashing the rest of the queue', async () => {
    mockGetAll.mockResolvedValue({
      ok: [
        {
          id: 3, operation: 'submit_quick_sale', status: 'pending', attempts: 0, last_error: null,
          idempotency_key: 'qs-1', entity_type: 'vente', queued_at: '2026-09-28T11:00:00.000Z', created_at: '2026-09-28T11:00:00.000Z',
          payload: 'not valid json {{{',
        },
        {
          id: 4, operation: 'submit_quick_sale', status: 'pending', attempts: 0, last_error: null,
          idempotency_key: 'qs-2', entity_type: 'vente', queued_at: '2026-09-28T11:05:00.000Z', created_at: '2026-09-28T11:05:00.000Z',
          payload: JSON.stringify({ p_business_id: 'biz-1', p_seller_id: 'user-1', p_unit_price: 100000, p_qty: 1 }),
        },
      ],
      corrupt: [
        { id: 99, operation: 'submit_sale', status: 'failed_corrupt', attempts: 3, last_error: 'decrypt failed', idempotency_key: null, entity_type: 'vente', queued_at: '2026-09-20T09:00:00.000Z' },
      ],
    });

    const result = await rebuildPendingOverlay([], ctx);
    // The JSON.parse-failure (id 3) and the pre-existing decrypt-failure (id 99)
    // both land in corrupt; the perfectly good id 4 still projects correctly.
    expect(result.corrupt.map(c => c.id).sort()).toEqual([3, 99]);
    expect(result.sales).toHaveLength(1);
    expect(result.sales[0].id).toBe('qs-2');
  });

  test('an unrelated queued operation (create_expense) does not appear in the sales overlay and does not throw', async () => {
    mockGetAll.mockResolvedValue({
      ok: [{
        id: 5, operation: 'create_expense', status: 'pending', attempts: 0, last_error: null,
        idempotency_key: null, entity_type: 'depense', queued_at: '2026-09-28T09:00:00.000Z', created_at: '2026-09-28T09:00:00.000Z',
        payload: JSON.stringify({ amount: 5000 }),
      }],
      corrupt: [],
    });
    const result = await rebuildPendingOverlay([baseSale({ id: 'existing' })], ctx);
    expect(result.sales).toHaveLength(1);
    expect(result.sales[0].id).toBe('existing');
  });
});
