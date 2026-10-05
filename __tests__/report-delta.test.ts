// The report-delta builder (lib/pendingOverlay.ts): what still-unsynced writes
// add to a server-computed report. Pure builder + the rebuild-level facts it
// relies on (failed_permanent split, payment events, allocations).

let mockItems: any[] = [];
jest.mock('@/lib/db', () => ({
  getAllQueueItemsForOverlay: async () => ({ ok: mockItems, corrupt: [] }),
}));

import {
  buildReportDelta, applyTopSellers, rebuildPendingOverlay, loadRefusedOps, pendingLedgerPayments,
  emptyReportDelta, type OverlaySale, type OverlayLine, type OverlayContext, type PendingPaymentEvent,
} from '@/lib/pendingOverlay';
import { applyDeltaToPeriodReport, applyDeltaToSnapshot, type PeriodReport, type ReportsSnapshot } from '@/stores/rapports';

jest.mock('@/lib/supabase', () => ({ supabase: { rpc: jest.fn(), from: jest.fn() } }));
jest.mock('@/stores/auth', () => ({ useAuthStore: { getState: () => ({ session: null }) } }));
jest.mock('@/stores/ventes', () => ({ useVentesStore: { getState: () => ({ sales: [] }), subscribe: () => () => {} } }));
jest.mock('@/stores/sync', () => ({ useSyncStore: { getState: () => ({ syncing: false }), subscribe: () => () => {} } }));

const PERIOD = { start: '2026-10-01', end: '2026-10-31', currentUserId: 'u1' };
const line = (product_id: string, qty: number, unit_price: number, product_name = product_id): OverlayLine => ({
  id: `l-${product_id}`, product_id, product_name, qty, unit_price, is_bulk: false, cost_price: 0,
});
function sale(o: Partial<OverlaySale> = {}): OverlaySale {
  return {
    id: 's1', business_id: 'biz-1', customer_name: null, client_id: null, seller_id: 'u1', seller_name: 'Fatou',
    status: 'paye', is_credit: false, total_amount: 5000, discount_amount: 0, amount_paid: 5000,
    paid_at: null, sale_date: '2026-10-03', due_date: null, created_at: '2026-10-03T10:00:00.000Z',
    cancelled_at: null, cancellation_reason: null, cancelled_by_id: null, cancelled_by_name: null,
    edit_count: 0, last_edited_at: null, profit: null,
    lines: [line('riz', 2, 2500)], payments: [{ id: 'p', method: 'especes', amount: 5000, date: '2026-10-03' }],
    _pending: true, ...o,
  };
}
const pay = (o: Partial<PendingPaymentEvent> = {}): PendingPaymentEvent => ({
  id: 'k1', operation: 'record_client_payment', amount: 1000, queuedAt: '2026-10-03T12:00:00.000Z', method: 'especes',
  date: '2026-10-03', allocations: [], businessId: 'biz-1', customerName: 'Aissatou', saleId: null, failedPermanent: false, ...o,
});

describe('buildReportDelta — buckets mirror get_period_report', () => {
  it('empty outbox → empty delta', () => {
    const d = buildReportDelta({ sales: [], payments: [] }, PERIOD);
    expect(d).toEqual(emptyReportDelta());
  });

  it('revenue = Σ(total − discount) for paye/credit in period; counts, units, cash', () => {
    const d = buildReportDelta({ sales: [
      sale({ id: 'a', total_amount: 5000, discount_amount: 500 }),
      sale({ id: 'b', status: 'credit', is_credit: true, total_amount: 10000, amount_paid: 0, payments: [], lines: [line('huile', 3, 3333)] }),
    ] }, PERIOD);
    expect(d.revenue).toBe(4500 + 10000);
    expect(d.salesCount).toBe(2);
    expect(d.unitsSold).toBe(2 + 3);
    expect(d.cashDelta).toBe(5000);          // only the upfront payment on the paid sale
    expect(d.creditDelta).toBe(10000);
    expect(d.creditCountDelta).toBe(1);
  });

  it('excludes cancelled, failed_permanent, synced (non-pending) and out-of-period sales from revenue', () => {
    const d = buildReportDelta({ sales: [
      sale({ id: 'x1', status: 'annule' }),
      sale({ id: 'x2', _failedPermanent: true }),
      sale({ id: 'x3', _pending: undefined }),
      sale({ id: 'x4', sale_date: '2026-09-30' }),
    ] }, PERIOD);
    expect(d.revenue).toBe(0);
    expect(d.salesCount).toBe(0);
  });

  it('a pending sale outside the period still moves the live balances (cash/credit are all-time)', () => {
    const d = buildReportDelta({ sales: [sale({ sale_date: '2026-09-30' })] }, PERIOD);
    expect(d.revenue).toBe(0);
    expect(d.cashDelta).toBe(5000);
  });

  it('profit is never estimated: net_profit untouched, pendingWithoutCost counts the pending sales', () => {
    const d = buildReportDelta({ sales: [sale({ id: 'a' }), sale({ id: 'b' })] }, PERIOD);
    expect(d.pendingWithoutCost).toBe(2);
    const base: PeriodReport = {
      role: 'administrateur', period_start: '2026-01-01', period_end: '2026-10-31', cash_on_hand: 0, net_profit: 123000,
      sales_count: 10, units_sold: 20, sales_without_cost: 1, credit_outstanding: 0, credit_count: 0, daily: [],
      my_sales_count: 0, my_units_sold: 0, my_credit_pending: 0, my_credit_count: 0, my_daily: [], investor_balance: 0, my_total_invested: 0,
    };
    const out = applyDeltaToPeriodReport(base, d, false);
    expect(out.net_profit).toBe(123000);
    expect(out.sales_without_cost).toBe(3);
    expect(out.sales_count).toBe(12);
    expect(out.units_sold).toBe(24);
  });

  it('payments reduce credit at FACE VALUE and add cash; the displayed outstanding clamps at 0', () => {
    const d = buildReportDelta({ sales: [], payments: [pay({ amount: 3000 }), pay({ id: 'k2', amount: 500 })] }, PERIOD);
    expect(d.creditDelta).toBe(-3500);
    expect(d.cashDelta).toBe(3500);
    const base = { role: 'administrateur', period_days: 30, period_start: '2026-10-01', credit_outstanding: 2000, credit_count: 1, cash_on_hand: 100, revenue: 0, period_order_count: 0, activity: [], top_sellers: [] } as unknown as ReportsSnapshot;
    const out = applyDeltaToSnapshot(base, d, false);
    expect(out.credit_outstanding).toBe(0);        // 2000 − 3500 clamps, never negative
    expect(out.cash_on_hand).toBe(3600);
  });

  it('a failed_permanent payment moves nothing', () => {
    const d = buildReportDelta({ sales: [], payments: [pay({ failedPermanent: true, amount: 9999 })] }, PERIOD);
    expect(d.cashDelta).toBe(0);
    expect(d.creditDelta).toBe(0);
  });

  it('daily map, staff leaderboard and topSellers (placeholders and unknown products excluded)', () => {
    const d = buildReportDelta({ sales: [
      sale({ id: 'a', lines: [line('riz', 2, 2500, 'Riz'), line('', 1, 100, 'Vente rapide'), line('sys', 1, 100, 'Solde reporté')] , total_amount: 5200, amount_paid: 5200, payments: [] }),
      sale({ id: 'b', sale_date: '2026-10-04', lines: [line('riz', 1, 2500, 'Riz')], total_amount: 2500, payments: [] }),
    ] }, { ...PERIOD, knownProductIds: new Set(['riz']) });
    expect(d.daily.get('2026-10-03')).toEqual({ amount: 5200, salesCount: 1, unitsSold: 4 });
    expect(d.daily.get('2026-10-04')).toEqual({ amount: 2500, salesCount: 1, unitsSold: 1 });
    expect([...d.topSellers.keys()]).toEqual(['riz']);
    expect(d.topSellers.get('riz')).toMatchObject({ qty: 3, revenue: 7500 });
    expect(d.staffSellers.get('Fatou')).toMatchObject({ revenue: 7700, count: 2 });
  });
});

describe('role scoping', () => {
  const mine = sale({ id: 'm', seller_id: 'u1' });
  const theirs = sale({ id: 't', seller_id: 'u2', seller_name: 'Moussa', total_amount: 9000, amount_paid: 9000, payments: [] });
  it('vendeur view takes only own sales into my_*, never the business-wide fields', () => {
    const d = buildReportDelta({ sales: [mine, theirs] }, PERIOD);
    expect(d.my.salesCount).toBe(1);
    expect(d.my.revenue).toBe(5000);
    const base = { role: 'vendeur', period_start: '2026-10-01', period_end: '2026-10-31', my_sales_count: 4, my_units_sold: 6, my_credit_pending: 0, my_credit_count: 0, my_daily: [], sales_count: 0, units_sold: 0, sales_without_cost: 0, cash_on_hand: 0, net_profit: 0, credit_outstanding: 0, credit_count: 0, daily: [], investor_balance: 0, my_total_invested: 0 } as PeriodReport;
    const out = applyDeltaToPeriodReport(base, d, true);
    expect(out.my_sales_count).toBe(5);
    expect(out.my_units_sold).toBe(8);
    expect(out.sales_count).toBe(0);          // untouched
    expect(out.cash_on_hand).toBe(0);         // untouched
    expect(out.net_profit).toBe(0);           // untouched
  });
  it('vendeur payments are not subtracted from my credit (owner of the debt unknown) — never understates', () => {
    const d = buildReportDelta({ sales: [], payments: [pay({ amount: 700 })] }, PERIOD);
    expect(d.my.creditDelta).toBe(0);
  });
});

describe('applyTopSellers (Home best-sellers consume the same builder)', () => {
  const row = (id: string, qty: number, rev: number) => ({ product_id: id, product_name: id, total_qty: qty, total_revenue: rev });
  const top = (entries: [string, number, number][]) => new Map(entries.map(([id, qty, revenue]) => [id, { product_id: id, product_name: id, qty, revenue }]));
  it('qty ≥ 2 after merging, revenue-desc, top 5', () => {
    expect(applyTopSellers([row('riz', 1, 5000)], top([['riz', 1, 5000]]))[0]).toMatchObject({ total_qty: 2, total_revenue: 10000 });
    expect(applyTopSellers([row('sel', 1, 500)], new Map())).toEqual([]);
    const base = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => row(id, 2, (i + 1) * 1000));
    expect(applyTopSellers(base, new Map()).map(r => r.product_id)).toEqual(['f', 'e', 'd', 'c', 'b']);
  });
  it('does not mutate the base rows', () => {
    const base = [row('riz', 2, 5000)];
    applyTopSellers(base, top([['riz', 1, 1]]));
    expect(base[0].total_qty).toBe(2);
  });
});

describe('rebuildPendingOverlay: failed_permanent split + payment events', () => {
  const ctx: OverlayContext = { currentUserId: 'u1', currentUserName: 'Fatou', currentBusinessId: 'biz-1' };
  const item = (id: number, operation: string, payload: object, status = 'pending', last_error: string | null = null) => ({
    id, operation, payload: JSON.stringify(payload), status, attempts: 0, last_error, idempotency_key: `key-${id}`,
    entity_type: 'vente', queued_at: '2026-10-03T10:00:00.000Z', created_at: '2026-10-03T10:00:00.000Z', next_attempt_at: '2026-10-03T10:00:00.000Z',
  });
  const quick = (n: number) => ({ p_business_id: 'biz-1', p_seller_id: 'u1', p_unit_price: 450000, p_qty: 1, p_label: null, p_idempotency_key: `key-${n}` });

  it('a refused sale stays in the ventes list but is excluded from the report delta, and surfaces in the notice with its reason', async () => {
    mockItems = [
      item(1, 'submit_quick_sale', quick(1)),
      item(2, 'submit_quick_sale', quick(2), 'failed_permanent', 'Stock insuffisant pour ce produit'),
    ];
    const { sales, payments } = await rebuildPendingOverlay([], ctx);
    expect(sales.map(s => s.id).sort()).toEqual(['key-1', 'key-2']);     // ventes list: both still there
    const refused = sales.find(s => s.id === 'key-2')!;
    expect(refused._failedPermanent).toBe(true);
    const d = buildReportDelta({ sales, payments }, { start: '2000-01-01', end: '2999-12-31', currentUserId: 'u1' });
    expect(d.revenue).toBe(4500);                                          // only the healthy one
    expect(d.salesCount).toBe(1);

    const notice = await loadRefusedOps('biz-1');
    expect(notice).toHaveLength(1);
    expect(notice[0]).toMatchObject({ id: 2, label: 'Vente', reason: 'Stock insuffisant pour ce produit' });
  });

  it('the notice is scoped to the current business', async () => {
    mockItems = [item(3, 'submit_quick_sale', { ...quick(3), p_business_id: 'other' }, 'failed_permanent', 'x')];
    expect(await loadRefusedOps('biz-1')).toEqual([]);
  });

  it('payment ops become events (id = idempotency key) with the FIFO split against the synced baseline', async () => {
    const baseline = [
      sale({ id: 'd1', _pending: undefined, status: 'credit', is_credit: true, customer_name: 'Aissatou', total_amount: 3000, amount_paid: 0, created_at: '2026-09-01T00:00:00.000Z', lines: [], payments: [] }),
      sale({ id: 'd2', _pending: undefined, status: 'credit', is_credit: true, customer_name: 'Aissatou', total_amount: 4000, amount_paid: 0, created_at: '2026-09-02T00:00:00.000Z', lines: [], payments: [] }),
    ];
    mockItems = [item(5, 'record_client_payment', { p_business_id: 'biz-1', p_customer_name: 'Aissatou', p_amount: 500000, p_method: 'especes', p_date: '2026-10-03', p_idempotency_key: 'key-5' })];
    const { payments } = await rebuildPendingOverlay(baseline, ctx);
    expect(payments).toHaveLength(1);
    expect(payments[0].id).toBe('key-5');
    expect(payments[0].allocations).toEqual([{ saleId: 'd1', amount: 3000 }, { saleId: 'd2', amount: 2000 }]);
    const rows = pendingLedgerPayments(payments, new Set(['d1', 'd2']));
    expect(rows.map(r => [r.id, r.order_id, r.amount, r._pending])).toEqual([['key-5', 'd1', 3000, true], ['key-5#2', 'd2', 2000, true]]);
  });

  it('a refused payment is not a ledger row', async () => {
    mockItems = [item(6, 'record_client_payment', { p_business_id: 'biz-1', p_customer_name: 'A', p_amount: 100, p_idempotency_key: 'key-6' }, 'failed_permanent', 'rejeté')];
    const { payments } = await rebuildPendingOverlay([], ctx);
    expect(pendingLedgerPayments(payments, new Set(['whatever']))).toEqual([]);
  });
});
