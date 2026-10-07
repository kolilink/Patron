// CALCULATION INTEGRITY — the offline → online invariant, deterministic.
//
//   a. online: capture every number the app shows = BASELINE
//   b. "airplane mode": record a fixed script (2 sales, 1 credit, 1 payment, 1 expense)
//      → the DISPLAYED numbers (server base + the outbox overlay, i.e. exactly what
//      the screens compute offline) must equal BASELINE + exactly those actions
//   c. "reconnect": replay the SAME queued payloads against the REAL RPCs, re-read
//      server truth → it must equal the offline-displayed numbers
//   d. the invariant: displayed_offline === displayed_online_after_sync, always.
//
// The offline side uses the app's own pure code (projectNewSale / applyPatchOp /
// salesKpisFromList / applyKpiOverlay / buildReportDelta / applyTopSellers /
// applyExpenseOverlay); the online side is the real Postgres functions. Any
// divergence between the two fails this test.
import { randomUUID } from 'crypto';
import { createTestUser, createTestBusiness, createTestProduct, getProductStock, adminClient } from './helpers';
import {
  projectNewSale, applyPatchOp, computeAllocations, buildReportDelta, applyTopSellers,
  type OverlaySale, type OverlayContext,
} from '@/lib/pendingOverlay';
import { applyKpiOverlay, salesKpisFromList } from '@/src/utils/salesTotals';
import { applyExpenseOverlay } from '@/lib/expenseOverlay';
import { localDateISO } from '@/src/utils/dates';

const TODAY = localDateISO();
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const round2 = (n: number) => Math.round(n * 100) / 100;

type Client = Awaited<ReturnType<typeof createTestUser>>['client'];
type Kpis = {
  revenue_today: number; revenue_yesterday: number; revenue_month: number;
  sales_today: number; credit_total: number; credit_count: number;
};

async function serverKpis(client: Client, businessId: string): Promise<Kpis> {
  const { data, error } = await client.rpc('get_dashboard_kpis', { p_business_id: businessId, p_today: TODAY, p_tz: TZ });
  expect(error).toBeNull();
  const d = data as Record<string, number>;
  return {
    revenue_today: Number(d.revenue_today) / 100,
    revenue_yesterday: Number(d.revenue_yesterday) / 100,
    revenue_month: Number(d.revenue_month) / 100,
    sales_today: Number(d.sales_today),
    credit_total: Number(d.credit_total) / 100,
    credit_count: Number(d.credit_count),
  };
}

async function serverSalesAsList(businessId: string): Promise<OverlaySale[]> {
  const admin = adminClient();
  const { data: orders } = await admin.from('sale_orders').select('*').eq('business_id', businessId);
  const ids = (orders ?? []).map(o => o.id as string);
  const { data: pays } = ids.length ? await admin.from('payments').select('order_id, amount').in('order_id', ids) : { data: [] as { order_id: string; amount: number }[] };
  const paid = new Map<string, number>();
  for (const p of pays ?? []) paid.set(p.order_id, (paid.get(p.order_id) ?? 0) + Number(p.amount));
  return (orders ?? []).map(o => ({
    id: o.id, business_id: o.business_id, customer_name: o.customer_name, client_id: o.client_id,
    seller_id: o.seller_id, seller_name: 'Admin', status: o.status, is_credit: o.is_credit,
    total_amount: Number(o.total_amount) / 100, discount_amount: Number(o.discount_amount ?? 0) / 100,
    amount_paid: (paid.get(o.id) ?? 0) / 100,
    paid_at: o.paid_at, sale_date: o.sale_date, due_date: o.due_date, created_at: o.created_at,
    cancelled_at: null, cancellation_reason: null, cancelled_by_id: null, cancelled_by_name: null,
    edit_count: 0, last_edited_at: null, profit: null, lines: [], payments: [],
  })) as OverlaySale[];
}

async function serverBestSellers(client: Client, businessId: string) {
  const monthStart = TODAY.slice(0, 8) + '01';
  const { data, error } = await client.rpc('get_best_sellers', { p_business_id: businessId, p_month_start: monthStart, p_limit: 5 });
  expect(error).toBeNull();
  return (data ?? []).map((r: { product_id: string; product_name: string; total_qty: number; total_revenue: number }) => ({
    product_id: r.product_id, product_name: r.product_name,
    total_qty: Number(r.total_qty), total_revenue: Number(r.total_revenue) / 100,
  }));
}

function clientRemaining(list: OverlaySale[], name: string): number {
  return round2(list
    .filter(s => s.status === 'credit' && s.customer_name === name)
    .reduce((sum, s) => sum + Math.max(0, s.total_amount - (s.discount_amount ?? 0) - (s.amount_paid ?? 0)), 0));
}

describe('offline → online calculation integrity (displayed_offline === displayed_online_after_sync)', () => {
  it('the fixed script: every on-screen number is identical offline and after sync, and equals baseline + exactly the script', async () => {
    const { client, userId } = await createTestUser('integrity');
    const businessId = await createTestBusiness(client, 'Boutique Integrité');
    const p1 = await createTestProduct(businessId, userId, { name: 'Riz', stock_qty: 100 });
    const p2 = await createTestProduct(businessId, userId, { name: 'Huile', stock_qty: 50 });
    const ctx: OverlayContext = { currentUserId: userId, currentUserName: 'Admin', currentBusinessId: businessId };

    // ── a. online baseline (a prior debt for "Awa" so a payment has something to settle) ──
    await client.rpc('submit_carnet_debt', { p_business_id: businessId, p_seller_id: userId, p_customer_name: 'Awa', p_amount: 100000, p_sale_date: TODAY });
    await client.rpc('submit_quick_sale', { p_business_id: businessId, p_seller_id: userId, p_unit_price: 50000, p_sale_date: TODAY });
    const baseKpis = await serverKpis(client, businessId);
    const baseList = await serverSalesAsList(businessId);
    const baseBest = await serverBestSellers(client, businessId);
    const baseStock1 = await getProductStock(p1);
    const baseStock2 = await getProductStock(p2);
    expect(baseKpis).toMatchObject({ sales_today: 2, revenue_today: 500, credit_total: 1000, credit_count: 1 });
    expect(clientRemaining(baseList, 'Awa')).toBe(1000);

    // ── b. "airplane mode": the fixed script, as the queued payloads ──
    const sale = (productId: string, name: string, qty: number, unitCents: number) => {
      const total = qty * unitCents;
      return {
        op: 'submit_sale' as const, key: randomUUID(),
        payload: {
          p_business_id: businessId, p_seller_id: userId, p_customer_name: null, p_sale_date: TODAY,
          p_total_amount: total, p_discount_amount: 0, p_is_credit: false,
          p_cart: [{ product_id: productId, qty, unit_price: unitCents, is_bulk: false, product_name: name, variant_id: null, variant_name: null }],
          p_pay_method: 'especes', p_pay_amount: total, p_pay_ref: null, p_client_id: null,
        } as Record<string, unknown>,
      };
    };
    const saleA = sale(p1, 'Riz', 2, 100000);      // 2 000
    const saleB = sale(p2, 'Huile', 2, 150000);    // 3 000
    const credit = {
      op: 'submit_carnet_debt' as const, key: randomUUID(),
      payload: { p_business_id: businessId, p_seller_id: userId, p_customer_name: 'Moussa', p_amount: 250000, p_client_id: null, p_sale_date: TODAY } as Record<string, unknown>,
    };
    const payment = {
      op: 'record_client_payment' as const, key: randomUUID(),
      payload: { p_business_id: businessId, p_customer_name: 'Awa', p_amount: 40000, p_method: 'especes', p_date: TODAY } as Record<string, unknown>,
    };
    const expense = {
      id: randomUUID(), business_id: businessId, amount: 75000, description: 'Transport', category: null,
      date: TODAY, due_date: null, note: null, product_id: null, status: 'approuve', created_by: userId,
    };
    const script = [saleA, saleB, credit, payment];

    // The displayed list offline = baseline + the outbox folded in queue order — the
    // exact reduction rebuildPendingOverlay performs (new sales prepended, patches applied).
    let offlineList: OverlaySale[] = baseList;
    for (const item of script) {
      const queuedAt = new Date().toISOString();
      if (item.op === 'record_client_payment') {
        offlineList = applyPatchOp(offlineList, item.op, item.payload, queuedAt, ctx);
      } else {
        const projected = projectNewSale(item.op, item.payload, queuedAt, ctx, item.key);
        expect(projected).not.toBeNull();
        offlineList = [projected as OverlaySale, ...offlineList];
      }
    }
    // (payment allocation sanity: oldest-first onto Awa's debt)
    expect(computeAllocations(baseList, businessId, 'Awa', 400)).toHaveLength(1);

    const offlineKpis = applyKpiOverlay(baseKpis, offlineList as never, baseList as never) as Kpis;
    const monthStart = TODAY.slice(0, 8) + '01';
    const pending = offlineList.filter(s => s._pending);
    const { topSellers } = buildReportDelta({ sales: pending }, { start: monthStart, end: TODAY, currentUserId: null, knownProductIds: new Set([p1, p2]) });
    const offlineBest = applyTopSellers(baseBest, topSellers);
    const offlineExpenses = applyExpenseOverlay([], [{ operation: 'create_expense', payload: expense }], { productNames: {}, creatorName: 'Admin', snapshots: new Map() });

    // …must equal BASELINE + exactly the script (hand-computed, no more, no less):
    expect(offlineKpis).toMatchObject({
      sales_today: baseKpis.sales_today + 3,                       // 2 sales + 1 credit; the payment is not a sale
      revenue_today: round2(baseKpis.revenue_today + 2000 + 3000), // cash sales only (credit & payment excluded)
      revenue_month: round2(baseKpis.revenue_month + 2000 + 3000),
      credit_total: round2(baseKpis.credit_total + 2500 - 400),    // Moussa +2500, Awa −400 (payment)
      credit_count: baseKpis.credit_count + 1,                     // Awa still owes, Moussa is new
    });
    expect(clientRemaining(offlineList, 'Awa')).toBe(600);
    expect(clientRemaining(offlineList, 'Moussa')).toBe(2500);
    expect(offlineExpenses.reduce((s, e) => s + e.amount, 0)).toBe(750);

    // ── c. "reconnect": replay the SAME payloads against the real RPCs ──
    for (const item of [saleA, saleB]) {
      const r = await client.rpc('submit_sale', { ...item.payload, p_idempotency_key: item.key });
      expect(r.error).toBeNull();
    }
    expect((await client.rpc('submit_carnet_debt', { ...credit.payload, p_idempotency_key: credit.key })).error).toBeNull();
    expect((await client.rpc('record_client_payment', { ...payment.payload, p_idempotency_key: payment.key })).error).toBeNull();
    expect((await client.from('expenses').insert(expense)).error).toBeNull();
    // a drain is at-least-once: replaying everything must change NOTHING (no double count)
    for (const item of [saleA, saleB]) await client.rpc('submit_sale', { ...item.payload, p_idempotency_key: item.key });
    await client.rpc('submit_carnet_debt', { ...credit.payload, p_idempotency_key: credit.key });
    await client.rpc('record_client_payment', { ...payment.payload, p_idempotency_key: payment.key });

    const onlineKpis = await serverKpis(client, businessId);
    const onlineList = await serverSalesAsList(businessId);
    const onlineBest = await serverBestSellers(client, businessId);

    // ── d. the invariant ──
    expect(onlineKpis).toEqual(offlineKpis);
    expect(clientRemaining(onlineList, 'Awa')).toBe(clientRemaining(offlineList, 'Awa'));
    expect(clientRemaining(onlineList, 'Moussa')).toBe(clientRemaining(offlineList, 'Moussa'));
    // the dashboard's own list-derived totals agree with server truth once settled (what verifyIntegrity asserts)
    const listKpis = salesKpisFromList(onlineList as never);
    expect(listKpis.sales_today).toBe(onlineKpis.sales_today);
    expect(round2(listKpis.revenue_today)).toBe(onlineKpis.revenue_today);
    // best sellers
    const norm = (rows: { product_id: string; total_qty: number; total_revenue: number }[]) =>
      rows.map(r => ({ id: r.product_id, qty: r.total_qty, rev: round2(r.total_revenue) })).sort((a, b) => a.id.localeCompare(b.id));
    expect(norm(onlineBest)).toEqual(norm(offlineBest));
    // stock counts: baseline − exactly what was sold
    expect(await getProductStock(p1)).toBe(baseStock1 - 2);
    expect(await getProductStock(p2)).toBe(baseStock2 - 2);
    // expense total: baseline 0 + exactly the one expense
    const { data: exp } = await adminClient().from('expenses').select('amount').eq('business_id', businessId);
    expect((exp ?? []).reduce((s, e) => s + Number(e.amount), 0) / 100).toBe(750);
  });
});
