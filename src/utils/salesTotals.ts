// Pure total/KPI derivations over useVentesStore.sales (display units).
// Extracted from Accueil, Ventes and the client carnet so the offline proof
// (__tests__/offline-totals-airplane.test.ts) exercises the exact code those
// screens run, not a copy of their formulas.

interface TotalsSale {
  id?: string;
  paid_at?: string | null;
  status: string;
  is_credit?: boolean;
  total_amount: number;
  discount_amount?: number | null;
  amount_paid?: number;
  sale_date?: string | null;
  created_at: string;
  customer_name?: string | null;
  client_id?: string | null;
}

export interface HomeKpisCache {
  revenue_yesterday?: number;
  revenue_month?: number;
  first_sale_at?: string | null;
}

export interface HomeKpis {
  revenue_today: number;
  revenue_yesterday: number;
  revenue_month: number;
  sales_today: number;
  credit_total: number;
  credit_count: number;
  low_stock: number;
  first_sale_at: string | null;
}

interface StockRow { reorder_level: number; stock_qty: number; has_variants?: boolean }

const net = (s: TotalsSale) => s.total_amount - (s.discount_amount ?? 0);

// Accueil's local-first KPI estimate: last cached server KPIs for the fields
// only the server can know (yesterday, month), live sales for the rest.
export function computeLocalKpis(args: {
  cached: HomeKpisCache | null;
  sales: (TotalsSale & { customer_name?: string | null })[];
  products: StockRow[];
  variantsByProduct: Record<string, StockRow[]>;
  now?: Date;
}): HomeKpis {
  const { cached, sales, products, variantsByProduct } = args;
  const now = args.now ?? new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const todaySales = sales.filter(s => (s.sale_date ?? localDay(s.created_at)) === today && s.status !== 'annule');
  const creditSales = sales.filter(s => s.status === 'credit');
  return {
    revenue_today: todaySales.filter(s => !s.is_credit).reduce((sum, s) => sum + net(s), 0),
    revenue_yesterday: cached?.revenue_yesterday ?? 0,
    revenue_month: cached?.revenue_month ?? 0,
    sales_today: todaySales.length,
    credit_total: creditSales.reduce((sum, s) => sum + (net(s) - (s.amount_paid ?? 0)), 0),
    credit_count: new Set(creditSales.map(s => s.customer_name).filter(Boolean)).size + creditSales.filter(s => !s.customer_name).length,
    low_stock: products.filter(p => !p.has_variants && p.reorder_level > 0 && p.stock_qty <= p.reorder_level).length
      + Object.values(variantsByProduct).flat().filter(v => v.reorder_level > 0 && v.stock_qty <= v.reorder_level).length,
    first_sale_at: cached?.first_sale_at ?? null,
  };
}

// Ventes list "Tout" summary: non-cancelled count and total.
export function activeSalesTotals(all: TotalsSale[]): { count: number; total: number } {
  const active = all.filter(s => s.status !== 'annule');
  return { count: active.length, total: active.reduce((sum, s) => sum + net(s), 0) };
}

// Client carnet: which sales belong to this client page.
export function selectClientSales<T extends TotalsSale>(
  sales: T[], routeParam: string, isClientId: boolean, displayName: string,
): T[] {
  const name = isClientId ? displayName : routeParam;
  return sales.filter(s =>
    s.status !== 'annule' &&
    (isClientId
      ? s.client_id === routeParam || (s.client_id == null && name && s.customer_name === name)
      : s.customer_name === routeParam),
  ) as T[];
}

export function clientBalance(clientSales: TotalsSale[], ledgerPayments: { amount: number }[]) {
  const totalSold = clientSales.reduce((s, v) => s + net(v), 0);
  const totalPaid = ledgerPayments.reduce((s, p) => s + p.amount, 0);
  return { totalSold, totalPaid, totalOwed: Math.max(0, totalSold - totalPaid) };
}

// ── Dashboard sales + debts, base + pending overlay ─────────────────────────
//
// Accueil's server figures come from get_dashboard_kpis (the whole business,
// however many sales). Local writes are outbox-first, so the server base is
// always missing whatever is still queued. The dashboard shows
//   server base + (figures over the outbox-aware list − figures over the
//                  synced baseline list)
// The formulas below mirror get_dashboard_kpis field by field, and the same
// formulas run over BOTH lists, so any limit of the local list (row caps, a
// window) cancels out of the difference: what remains is exactly what the
// pending ops change. With an empty outbox the difference is 0 and the
// dashboard IS the server read; with pending ops it equals the list-derived
// totals the lists themselves show.

export interface SalesKpis {
  revenue_today: number;
  revenue_yesterday: number;
  revenue_month: number;
  sales_today: number;
  credit_total: number;
  credit_count: number;
}

// A timestamp's LOCAL calendar day (mirrors the server's paid_at windows, which
// use the merchant's timezone since migration_v242); a bare date passes through.
const localDay = (iso: string) => (iso.includes('T') ? ymd(new Date(iso)) : iso.slice(0, 10));
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** get_dashboard_kpis' sales + debts fields, computed over a sales list (display units). */
export function salesKpisFromList(sales: TotalsSale[], now: Date = new Date()): SalesKpis {
  const today = ymd(now);
  const y = new Date(now); y.setDate(y.getDate() - 1);
  const yesterday = ymd(y);
  const monthStart = ymd(new Date(now.getFullYear(), now.getMonth(), 1));

  let revenue_today = 0, revenue_yesterday = 0, revenue_month = 0, sales_today = 0, credit_total = 0;
  const debtors = new Set<string>();
  let anonymousDebts = 0;

  for (const s of sales) {
    const day = (s.sale_date ?? localDay(s.created_at));
    if (s.status !== 'annule' && day === today) {
      sales_today += 1;
      if (!s.is_credit) revenue_today += net(s);
    }
    if (s.status === 'paye') {
      const paidDay = localDay(s.paid_at ?? s.sale_date ?? s.created_at);
      if (paidDay === yesterday) revenue_yesterday += net(s);
      if (paidDay >= monthStart) revenue_month += net(s);
    }
    if (s.status === 'credit') {
      const remaining = Math.max(0, net(s) - (s.amount_paid ?? 0));
      credit_total += remaining;
      if (remaining > 0.005) {
        if (s.customer_name) debtors.add(s.customer_name); else anonymousDebts += 1;
      }
    }
  }
  return { revenue_today, revenue_yesterday, revenue_month, sales_today, credit_total, credit_count: debtors.size + anonymousDebts };
}

/** Server base + what the outbox changes (overlay list vs. its synced baseline). Never negative. */
export function applyKpiOverlay<B extends SalesKpis>(
  base: B,
  overlay: TotalsSale[],
  baseline: TotalsSale[],
  now: Date = new Date(),
): B {
  const o = salesKpisFromList(overlay, now);
  const b = salesKpisFromList(baseline, now);
  const add = (server: number, ov: number, bl: number) => Math.max(0, server + (ov - bl));
  return {
    ...base,
    revenue_today: add(base.revenue_today, o.revenue_today, b.revenue_today),
    revenue_yesterday: add(base.revenue_yesterday, o.revenue_yesterday, b.revenue_yesterday),
    revenue_month: add(base.revenue_month, o.revenue_month, b.revenue_month),
    sales_today: add(base.sales_today, o.sales_today, b.sales_today),
    credit_total: add(base.credit_total, o.credit_total, b.credit_total),
    credit_count: add(base.credit_count, o.credit_count, b.credit_count),
  };
}
