// computeBestSellersDelta / mergeBestSellers (lib/pendingOverlay.ts): what
// still-unsynced sales add to Accueil's month best-sellers ranking.

jest.mock('@/lib/db', () => ({ getAllQueueItemsForOverlay: jest.fn() }));

import {
  computeBestSellersDelta,
  mergeBestSellers,
  type OverlaySale,
  type OverlayLine,
} from '@/lib/pendingOverlay';

const MONTH_START = '2026-10-01';
const known = new Set(['riz', 'huile', 'sucre', 'lait', 'pain', 'sel']);

const line = (product_id: string, qty: number, unit_price: number, product_name = product_id): OverlayLine => ({
  id: `l-${product_id}-${qty}`, product_id, product_name, qty, unit_price, is_bulk: false, cost_price: 0,
});

function sale(overrides: Partial<OverlaySale> = {}): OverlaySale {
  return {
    id: 's1', business_id: 'biz-1', customer_name: null, client_id: null,
    seller_id: 'u1', seller_name: 'Fatou', status: 'paye', is_credit: false,
    total_amount: 0, discount_amount: 0, amount_paid: 0, paid_at: null,
    sale_date: '2026-10-03', due_date: null, created_at: '2026-10-03T10:00:00.000Z',
    cancelled_at: null, cancellation_reason: null, cancelled_by_id: null, cancelled_by_name: null,
    edit_count: 0, last_edited_at: null, profit: null, lines: [], payments: [], _pending: true,
    ...overrides,
  };
}

describe('computeBestSellersDelta', () => {
  it('empty outbox -> empty delta', () => {
    expect(computeBestSellersDelta([], MONTH_START, known)).toEqual([]);
  });

  it('counts pending sales, summing qty and revenue per product across sales', () => {
    const delta = computeBestSellersDelta([
      sale({ id: 'a', lines: [line('riz', 2, 5000, 'Riz'), line('huile', 1, 3000)] }),
      sale({ id: 'b', lines: [line('riz', 1, 5000, 'Riz')] }),
    ], MONTH_START, known);
    const riz = delta.find(d => d.product_id === 'riz')!;
    expect(riz).toMatchObject({ product_name: 'Riz', qty: 3, revenue: 15000 });
    expect(delta.find(d => d.product_id === 'huile')).toMatchObject({ qty: 1, revenue: 3000 });
  });

  it('ignores synced rows (no _pending) — the server base already counts them', () => {
    const delta = computeBestSellersDelta([
      sale({ _pending: undefined, lines: [line('riz', 5, 5000)] }),
    ], MONTH_START, known);
    expect(delta).toEqual([]);
  });

  it('excludes cancelled sales', () => {
    const delta = computeBestSellersDelta([
      sale({ status: 'annule', lines: [line('riz', 5, 5000)] }),
    ], MONTH_START, known);
    expect(delta).toEqual([]);
  });

  it('excludes placeholder products ("Solde reporté", "Vente rapide") — not in the known catalog set', () => {
    const delta = computeBestSellersDelta([
      sale({ lines: [line('sys-solde', 1, 10000, 'Solde reporté')] }),
      sale({ id: 'q', lines: [line('sys-vr', 3, 1500, 'Vente rapide')] }),
    ], MONTH_START, known);
    expect(delta).toEqual([]);
  });

  it('excludes sales dated before the month start', () => {
    const delta = computeBestSellersDelta([
      sale({ sale_date: '2026-09-30', lines: [line('riz', 5, 5000)] }),
    ], MONTH_START, known);
    expect(delta).toEqual([]);
  });

  it('falls back to created_at when sale_date is null', () => {
    const delta = computeBestSellersDelta([
      sale({ sale_date: null, created_at: '2026-10-02T08:00:00.000Z', lines: [line('riz', 2, 5000)] }),
    ], MONTH_START, known);
    expect(delta).toHaveLength(1);
  });
});

describe('mergeBestSellers', () => {
  const row = (id: string, qty: number, revenue: number) => ({ product_id: id, product_name: id, total_qty: qty, total_revenue: revenue });

  it('empty base + empty delta -> empty', () => {
    expect(mergeBestSellers([], [])).toEqual([]);
  });

  it('applies the qty >= 2 filter after merging (1 pending + 1 base crosses the line)', () => {
    const out = mergeBestSellers(
      [row('riz', 1, 5000), row('sel', 1, 500)],
      [{ product_id: 'riz', product_name: 'riz', qty: 1, revenue: 5000 }],
    );
    expect(out.map(r => r.product_id)).toEqual(['riz']);
    expect(out[0]).toMatchObject({ total_qty: 2, total_revenue: 10000 });
  });

  it('sorts by revenue descending and keeps only the top 5', () => {
    const base = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => row(id, 2, (i + 1) * 1000));
    const out = mergeBestSellers(base, []);
    expect(out.map(r => r.product_id)).toEqual(['f', 'e', 'd', 'c', 'b']);
  });

  it('a delta can push a product from outside the top 5 into it', () => {
    const base = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => row(id, 2, (i + 1) * 1000));
    const out = mergeBestSellers(base, [{ product_id: 'a', product_name: 'a', qty: 1, revenue: 50000 }]);
    expect(out[0].product_id).toBe('a');
    expect(out).toHaveLength(5);
  });

  it('does not mutate the base rows', () => {
    const base = [row('riz', 2, 5000)];
    mergeBestSellers(base, [{ product_id: 'riz', product_name: 'riz', qty: 1, revenue: 1 }]);
    expect(base[0].total_qty).toBe(2);
  });
});
