// Pure total/KPI derivations over useVentesStore.sales (display units).
// Extracted from Accueil, Ventes and the client carnet so the offline proof
// (__tests__/offline-totals-airplane.test.ts) exercises the exact code those
// screens run, not a copy of their formulas.

interface TotalsSale {
  id?: string;
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
  const todaySales = sales.filter(s => (s.sale_date ?? s.created_at.split('T')[0]) === today && s.status !== 'annule');
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
