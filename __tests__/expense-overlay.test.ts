import { applyExpenseOverlay } from '@/lib/expenseOverlay';
import type { Expense } from '@/src/types';

const base = (o: Partial<Expense>): Expense => ({
  id: 'e1', business_id: 'b', amount: 100, description: 'x', category: null, date: '2026-10-05', due_date: null,
  note: null, status: 'approuve', created_by: 'u', approved_by: null, approved_at: null,
  created_at: '2026-10-05T00:00:00Z', updated_at: '2026-10-05T00:00:00Z', ...o,
});
const ctx = () => ({ productNames: { p1: 'Riz 50 kg' }, creatorName: 'Moi', snapshots: new Map<string, Expense>() });
const create = { id: 'n1', business_id: 'b', amount: 2500000, description: 'Dépense', category: null, date: '2026-10-05', due_date: null, note: null, product_id: 'p1', status: 'approuve', created_by: 'u' };

describe('applyExpenseOverlay', () => {
  it('shows a queued create on top, in display units, with the product name', () => {
    const out = applyExpenseOverlay([base({})], [{ operation: 'create_expense', payload: create }], ctx());
    expect(out[0]).toMatchObject({ id: 'n1', amount: 25000, product_name: 'Riz 50 kg', creator_name: 'Moi' });
    expect(out).toHaveLength(2);
  });
  it('does not duplicate a create the server already echoed', () => {
    const out = applyExpenseOverlay([base({ id: 'n1' })], [{ operation: 'create_expense', payload: create }], ctx());
    expect(out).toHaveLength(1);
  });
  it('applies update (change and unlink the product) in queue order', () => {
    const baseline = [base({ product_id: 'p1', product_name: 'Riz 50 kg' })];
    const out = applyExpenseOverlay(baseline, [
      { operation: 'update_expense', payload: { id: 'e1', amount: 300000, description: 'x', category: null, date: '2026-10-05', due_date: null, note: 'a', product_id: null } },
    ], ctx());
    expect(out[0]).toMatchObject({ amount: 3000, product_id: null, product_name: null, note: 'a' });
  });
  it('queued delete removes the row, queued restore brings it back from the snapshot', () => {
    const c = ctx();
    const baseline = [base({})];
    const gone = applyExpenseOverlay(baseline, [{ operation: 'delete_expense', payload: { p_expense_id: 'e1' } }], c);
    expect(gone).toEqual([]);
    const back = applyExpenseOverlay([], [{ operation: 'restore_expense', payload: { p_expense_id: 'e1' } }], c);
    expect(back.map(e => e.id)).toEqual(['e1']);
  });
  it('is a pure fold: the baseline is never mutated', () => {
    const baseline = [base({})];
    applyExpenseOverlay(baseline, [{ operation: 'update_expense', payload: { id: 'e1', amount: 5, description: 'x', date: '2026-10-05' } }], ctx());
    expect(baseline[0].amount).toBe(100);
  });
});
