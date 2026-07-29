import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { saveRapportsCache, getRapportsCache, getCacheTimestamp } from '@/lib/db';
import { isNetworkError, withTimeout, withNetworkRetry, reportOfflineFallback } from '@/lib/sync';
import { useAuthStore } from '@/stores/auth';

// See stores/products.ts for the full explanation.
function isStaleBusiness(businessId: string): boolean {
  return useAuthStore.getState().session?.activeBusiness?.id !== businessId;
}

export interface StockVelocityItem {
  item_id: string;
  item_name: string;
  stock_qty: number;
  days_remaining: number | null; // -1 = rupture, null = no sales data, 0+ = days
}

export interface ActivityPoint {
  date: string;    // ISO date "YYYY-MM-DD"
  amount: number;  // display units (already ÷100)
}

export interface TopSeller {
  name: string;
  revenue: number; // display units (÷100)
  count: number;
}

export interface DailyPoint {
  date: string;        // ISO date "YYYY-MM-DD"
  amount: number;      // display units (already ÷100)
  sales_count: number;
  units_sold: number;
}

// Backs the year heatmap + period-filter drill-down in app/(app)/rapports.
// Calendar-anchored (period_start/period_end), unlike ReportsSnapshot's
// rolling period_days — see db/migration_v154.sql's header note.
export interface PeriodReport {
  role: string;
  period_start: string;
  period_end: string;
  // Admin / manager / investisseur
  cash_on_hand: number;
  net_profit: number;
  sales_count: number;
  units_sold: number;
  credit_outstanding: number;
  credit_count: number;
  daily: DailyPoint[];
  // Vendeur
  my_sales_count: number;
  my_units_sold: number;
  my_credit_pending: number;
  my_credit_count: number;
  my_daily: DailyPoint[];
  // Investisseur
  investor_balance: number;
  my_total_invested: number;
}

export interface ReportsSnapshot {
  role: string;
  period_days: number;
  period_start: string;
  // Admin / manager / investisseur
  revenue: number;
  cogs: number;
  stock_losses: number;
  gross_profit: number;
  operating_expenses: number;
  shipping_expenses: number;
  net_profit: number;
  credit_outstanding: number;
  credit_count: number;
  period_order_count: number;
  cash_on_hand: number;
  stock_value: number;
  total_apports: number;
  period_apports: number;
  activity: ActivityPoint[];
  top_sellers: TopSeller[];
  // Vendeur
  my_revenue: number;
  my_sales_count: number;
  my_credit_pending: number;
  my_credit_count: number;
  my_activity: ActivityPoint[];
  // Investisseur
  investor_balance: number;
  my_total_invested: number;
  my_period_apports: number;
}

interface RapportsState {
  snapshot: ReportsSnapshot | null;
  snapshotLoading: boolean;
  offline: boolean;
  offlineSince: number | null;
  stockVelocity: StockVelocityItem[];
  velocityLoading: boolean;
  fetchReportsSnapshot: (
    businessId: string,
    periodDays: number,
    role: string,
    userId: string,
    today?: string,
  ) => Promise<void>;
  fetchStockVelocity: (businessId: string) => Promise<void>;

  // Year heatmap (Jan 1 → today/Dec 31 of the selected year) — always
  // fetched, drives the headline cards + heatmap coloring.
  yearReport: PeriodReport | null;
  yearReportLoading: boolean;
  // Drill-down for a selected sub-period (jour/semaine/trimestre/semestre/
  // personnalisé). null when no filter narrower than the full year is active.
  filterReport: PeriodReport | null;
  filterReportLoading: boolean;
  periodOffline: boolean;
  periodOfflineSince: number | null;
  fetchYearReport: (
    businessId: string,
    year: number,
    role: string,
    userId: string,
  ) => Promise<void>;
  fetchFilterReport: (
    businessId: string,
    periodStart: string,
    periodEnd: string,
    role: string,
    userId: string,
  ) => Promise<void>;
  clearFilterReport: () => void;

  reset: () => void;
}

function parseSnapshot(raw: Record<string, unknown>): ReportsSnapshot {
  const cents = (k: string) => ((raw[k] as number) ?? 0) / 100;
  const parseActivity = (key: string): ActivityPoint[] =>
    ((raw[key] as Array<{ date: string; amount: number }>) ?? []).map(pt => ({
      date:   pt.date,
      amount: pt.amount / 100,
    }));
  const parseSellers = (): TopSeller[] =>
    ((raw['top_sellers'] as Array<{ name: string; revenue: number; count: number }>) ?? []).map(s => ({
      name:    s.name,
      revenue: s.revenue / 100,
      count:   s.count,
    }));

  return {
    role:               (raw['role'] as string) ?? '',
    period_days:        (raw['period_days'] as number) ?? 0,
    period_start:       (raw['period_start'] as string) ?? '',
    revenue:            cents('revenue'),
    cogs:               cents('cogs'),
    stock_losses:       cents('stock_losses'),
    gross_profit:       cents('gross_profit'),
    operating_expenses: cents('operating_expenses'),
    shipping_expenses:  cents('shipping_expenses'),
    net_profit:         cents('net_profit'),
    credit_outstanding: cents('credit_outstanding'),
    credit_count:       (raw['credit_count'] as number) ?? 0,
    period_order_count: (raw['period_order_count'] as number) ?? 0,
    cash_on_hand:       cents('cash_on_hand'),
    stock_value:        cents('stock_value'),
    total_apports:      cents('total_apports'),
    period_apports:     cents('period_apports'),
    activity:           parseActivity('activity'),
    top_sellers:        parseSellers(),
    my_revenue:         cents('my_revenue'),
    my_sales_count:     (raw['my_sales_count'] as number) ?? 0,
    my_credit_pending:  cents('my_credit_pending'),
    my_credit_count:    (raw['my_credit_count'] as number) ?? 0,
    my_activity:        parseActivity('my_activity'),
    investor_balance:   cents('investor_balance'),
    my_total_invested:  cents('my_total_invested'),
    my_period_apports:  cents('my_period_apports'),
  };
}

function parsePeriodReport(raw: Record<string, unknown>): PeriodReport {
  const cents = (k: string) => ((raw[k] as number) ?? 0) / 100;
  const parseDaily = (key: string): DailyPoint[] =>
    ((raw[key] as Array<{ date: string; amount: number; sales_count: number; units_sold: number }>) ?? []).map(pt => ({
      date:        pt.date,
      amount:      pt.amount / 100,
      sales_count: pt.sales_count,
      units_sold:  pt.units_sold,
    }));

  return {
    role:                (raw['role'] as string) ?? '',
    period_start:        (raw['period_start'] as string) ?? '',
    period_end:          (raw['period_end'] as string) ?? '',
    cash_on_hand:        cents('cash_on_hand'),
    net_profit:          cents('net_profit'),
    sales_count:         (raw['sales_count'] as number) ?? 0,
    units_sold:          (raw['units_sold'] as number) ?? 0,
    credit_outstanding:  cents('credit_outstanding'),
    credit_count:        (raw['credit_count'] as number) ?? 0,
    daily:               parseDaily('daily'),
    my_sales_count:      (raw['my_sales_count'] as number) ?? 0,
    my_units_sold:       (raw['my_units_sold'] as number) ?? 0,
    my_credit_pending:   cents('my_credit_pending'),
    my_credit_count:     (raw['my_credit_count'] as number) ?? 0,
    my_daily:            parseDaily('my_daily'),
    investor_balance:    cents('investor_balance'),
    my_total_invested:   cents('my_total_invested'),
  };
}

// Shared by fetchYearReport/fetchFilterReport — same cache/offline-timeout
// pattern as fetchReportsSnapshot, parameterized by which state slot
// (year vs. filter) to write into.
async function loadPeriodReport(
  businessId: string, periodStart: string, periodEnd: string, role: string, userId: string,
  set: (partial: Partial<RapportsState>) => void,
  slot: 'year' | 'filter',
): Promise<void> {
  const loadingKey = slot === 'year' ? 'yearReportLoading' : 'filterReportLoading';
  const dataKey    = slot === 'year' ? 'yearReport'        : 'filterReport';
  set({ [loadingKey]: true } as Partial<RapportsState>);

  const cacheKey = `${businessId}:${role}:${userId}:${periodStart}:${periodEnd}`;
  const { data, error } = await withNetworkRetry(() =>
    supabase.rpc('get_period_report', {
      p_business_id:  businessId,
      p_period_start: periodStart,
      p_period_end:   periodEnd,
      p_role:         role,
      p_user_id:      userId,
    }),
  ).catch(err => ({ data: null, error: err }));
  if (isStaleBusiness(businessId)) return;

  if (error || !data) {
    if (isNetworkError(error)) {
      reportOfflineFallback('rapports.loadPeriodReport', error);
      const cached = await getRapportsCache(cacheKey);
      if (isStaleBusiness(businessId)) return;
      if (cached) {
        const ts = await getCacheTimestamp('rapports_cache', cacheKey);
        if (isStaleBusiness(businessId)) return;
        set({
          [dataKey]: parsePeriodReport(cached as Record<string, unknown>),
          [loadingKey]: false,
          periodOffline: true,
          periodOfflineSince: ts,
        } as Partial<RapportsState>);
        return;
      }
      set({ [loadingKey]: false, periodOffline: true, periodOfflineSince: null } as Partial<RapportsState>);
      return;
    }
    set({ [loadingKey]: false } as Partial<RapportsState>);
    return;
  }
  void saveRapportsCache(cacheKey, data);
  set({
    [dataKey]: parsePeriodReport(data as Record<string, unknown>),
    [loadingKey]: false,
    periodOffline: false,
    periodOfflineSince: null,
  } as Partial<RapportsState>);
}

export const useRapportsStore = create<RapportsState>((set) => ({
  snapshot: null,
  snapshotLoading: false,
  offline: false,
  offlineSince: null,
  stockVelocity: [],
  velocityLoading: false,

  yearReport: null,
  yearReportLoading: false,
  filterReport: null,
  filterReportLoading: false,
  periodOffline: false,
  periodOfflineSince: null,

  fetchReportsSnapshot: async (businessId, periodDays, role, userId, today) => {
    set({ snapshotLoading: true });
    // rapports_cache's `business_id` column is a plain TEXT PRIMARY KEY (no FK),
    // so it doubles as a generic cache key here — packing in periodDays/role/userId
    // is a value-only change, no migration needed. Without this, Semaine/Mois/
    // Trimestre all overwrote the same single slot, so offline always showed
    // whichever period tab happened to be fetched last, regardless of which
    // tab was actually open; role/userId are included too since a vendeur's
    // personal figures and an admin's full-business figures must never be
    // served from each other's cache slot on a shared device.
    const cacheKey = `${businessId}:${role}:${userId}:${periodDays}`;
    const { data, error } = await withNetworkRetry(() =>
      supabase.rpc('get_reports_snapshot', {
        p_business_id: businessId,
        p_period_days: periodDays,
        p_role:        role,
        p_user_id:     userId,
        p_today:       today ?? new Date().toISOString().split('T')[0],
      }),
    ).catch(err => ({ data: null, error: err }));
    if (isStaleBusiness(businessId)) return;
    if (error || !data) {
      if (isNetworkError(error)) {
        reportOfflineFallback('rapports.fetchReportsSnapshot', error);
        const cached = await getRapportsCache(cacheKey);
        if (isStaleBusiness(businessId)) return;
        if (cached) {
          const ts = await getCacheTimestamp('rapports_cache', cacheKey);
          if (isStaleBusiness(businessId)) return;
          set({
            snapshot: parseSnapshot(cached as Record<string, unknown>),
            snapshotLoading: false,
            offline: true,
            offlineSince: ts,
          });
          return;
        }
        set({ snapshotLoading: false, offline: true, offlineSince: null });
        return;
      }
      set({ snapshotLoading: false });
      return;
    }
    void saveRapportsCache(cacheKey, data);
    set({ snapshot: parseSnapshot(data as Record<string, unknown>), snapshotLoading: false, offline: false, offlineSince: null });
  },

  fetchStockVelocity: async (businessId) => {
    set({ velocityLoading: true });
    const { data, error } = await withTimeout(
      supabase.rpc('get_stock_velocity', {
        p_business_id: businessId,
      }),
    ).catch(err => ({ data: null, error: err }));
    if (isStaleBusiness(businessId)) return;
    if (error || !data) { set({ velocityLoading: false }); return; }
    set({
      stockVelocity: (data as Record<string, unknown>[]).map(r => ({
        item_id:        r['item_id'] as string,
        item_name:      r['item_name'] as string,
        stock_qty:      r['stock_qty'] as number,
        days_remaining: r['days_remaining'] as number | null,
      })),
      velocityLoading: false,
    });
  },

  fetchYearReport: (businessId, year, role, userId) => {
    const today = new Date();
    const isCurrentYear = year === today.getFullYear();
    const periodStart = `${year}-01-01`;
    const periodEnd = isCurrentYear
      ? today.toISOString().split('T')[0]
      : `${year}-12-31`;
    return loadPeriodReport(businessId, periodStart, periodEnd, role, userId, set, 'year');
  },

  fetchFilterReport: (businessId, periodStart, periodEnd, role, userId) =>
    loadPeriodReport(businessId, periodStart, periodEnd, role, userId, set, 'filter'),

  clearFilterReport: () => set({ filterReport: null, filterReportLoading: false }),

  reset: () => set({
    snapshot: null, snapshotLoading: false, offline: false, offlineSince: null,
    stockVelocity: [], velocityLoading: false,
    yearReport: null, yearReportLoading: false,
    filterReport: null, filterReportLoading: false,
    periodOffline: false, periodOfflineSince: null,
  }),
}));
