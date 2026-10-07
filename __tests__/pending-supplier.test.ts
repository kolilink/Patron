import { applyPendingSupplierOps, type DebtRow, type QueuedSupplierOp } from '@/lib/pendingSupplier';

const debt = (over: Partial<DebtRow>): DebtRow => ({
  id: 'd1', business_id: 'b', supplier_id: 's1', amount: 100, amount_paid: 0, description: null,
  date: '2026-10-01', created_at: '2026-10-01T00:00:00Z', ...over,
});
const pay = (cents: number, key = 'k1', at = '2026-10-07T10:00:00Z'): QueuedSupplierOp => ({
  operation: 'pay_supplier_debt', queuedAt: at,
  payload: { p_business_id: 'b', p_supplier_id: 's1', p_amount_cents: cents, p_idempotency_key: key },
});

describe('pending supplier ops overlay', () => {
  it('a queued payment is allocated oldest-first, exactly like the server, and logged as a payment row', () => {
    const base = [debt({ id: 'old', amount: 50, created_at: '2026-09-01T00:00:00Z' }), debt({ id: 'new', amount: 100 })];
    const out = applyPendingSupplierOps(base, [], [pay(8000)], { userId: 'u' });
    expect(out.debts.find(x => x.id === 'old')!.amount_paid).toBe(50);
    expect(out.debts.find(x => x.id === 'new')!.amount_paid).toBe(30);
    expect(out.payments).toHaveLength(1);
    expect(out.payments[0]).toMatchObject({ amount: 80, paid_by: 'u', supplier_id: 's1' });
  });

  it('only what could be allocated is logged (an excess is not invented as paid)', () => {
    const out = applyPendingSupplierOps([debt({ amount: 40 })], [], [pay(10000)], { userId: 'u' });
    expect(out.debts[0].amount_paid).toBe(40);
    expect(out.payments[0].amount).toBe(40);
  });

  it('a queued debt shows up, and a payment queued after it is allocated against it', () => {
    const create: QueuedSupplierOp = {
      operation: 'create_supplier_debt', queuedAt: '2026-10-07T09:00:00Z',
      payload: { id: 'dx', business_id: 'b', supplier_id: 's1', amount: 25000, description: 'Riz', date: '2026-10-07' },
    };
    const out = applyPendingSupplierOps([], [], [create, pay(10000)], { userId: 'u' });
    expect(out.debts).toHaveLength(1);
    expect(out.debts[0]).toMatchObject({ id: 'dx', amount: 250, amount_paid: 100 });
  });

  it('a debt the server list already has is not added twice', () => {
    const create: QueuedSupplierOp = { operation: 'create_supplier_debt', queuedAt: 'x', payload: { id: 'd1', business_id: 'b', supplier_id: 's1', amount: 10000 } };
    expect(applyPendingSupplierOps([debt({})], [], [create], { userId: 'u' }).debts).toHaveLength(1);
  });

  it('a payment for another supplier does not touch this one', () => {
    const other: QueuedSupplierOp = { operation: 'pay_supplier_debt', queuedAt: 'x', payload: { p_supplier_id: 'other', p_amount_cents: 5000, p_idempotency_key: 'k' } };
    const out = applyPendingSupplierOps([debt({})], [], [other], { userId: 'u' });
    expect(out.debts[0].amount_paid).toBe(0);
    expect(out.payments).toHaveLength(0);
  });
});
