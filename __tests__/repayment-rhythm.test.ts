import { repaymentRhythm, rhythmLabel, median } from '@/src/utils/repaymentRhythm';

const day = (n: number) => `2026-03-${String(n).padStart(2, '0')}`;
const settled = (id: string, from: number, to: number) => ({
  id, status: 'paye', is_credit: true, total_amount: 1000, sale_date: day(from),
  created_at: `${day(from)}T09:00:00Z`, paid_at: `${day(to)}T12:00:00`,
});

describe('repaymentRhythm', () => {
  it('median of [4, 5, 60] is 5 (one slow outlier does not move it)', () => {
    expect(median([60, 4, 5])).toBe(5);
    const sixty = { ...settled('c', 1, 1), sale_date: '2026-01-01', paid_at: '2026-03-02T12:00:00' }; // 60 days
    const r = repaymentRhythm([settled('a', 1, 5), settled('b', 1, 6), sixty], []);
    expect(r).toEqual({ medianDays: 5, settledCount: 3 });
  });

  it('nothing settled -> null, so the screen renders nothing', () => {
    expect(repaymentRhythm([], [])).toBeNull();
  });

  it('outstanding debts are excluded entirely', () => {
    const open = { id: 'o', status: 'credit', is_credit: true, total_amount: 500, sale_date: day(1), created_at: day(1) + 'T00:00:00Z', paid_at: null };
    const cash = { id: 'c', status: 'paye', is_credit: false, total_amount: 500, sale_date: day(1), created_at: day(1) + 'T00:00:00Z', paid_at: day(1) + 'T10:00:00' };
    const r = repaymentRhythm([open, cash, settled('a', 1, 4)], []);
    expect(r).toEqual({ medianDays: 3, settledCount: 1 });
  });

  it('a single settled debt shows with "(1 crédit soldé)"', () => {
    const r = repaymentRhythm([settled('a', 1, 4)], [])!;
    expect(rhythmLabel(r)).toEqual({ main: 'En général, soldé en 3 jours', sub: '(1 crédit soldé)' });
  });

  it('missing paid_at falls back to the last payment; unknowable is excluded', () => {
    const noPaid = { ...settled('a', 1, 1), paid_at: null };
    const unknowable = { ...settled('b', 1, 1), paid_at: null };
    const r = repaymentRhythm([noPaid, unknowable], [
      { order_id: 'a', date: day(3) }, { order_id: 'a', date: day(8) },
    ]);
    expect(r).toEqual({ medianDays: 7, settledCount: 1 });
  });

  it('plural / same-day wording', () => {
    expect(rhythmLabel({ medianDays: 1, settledCount: 3 }).main).toBe('En général, soldé en 1 jour');
    expect(rhythmLabel({ medianDays: 0, settledCount: 2 }).main).toBe('En général, soldé le jour même');
  });
});
