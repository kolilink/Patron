import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { saveRapportsCache, getRapportsCache, getCacheTimestamp } from '@/lib/db';
import { isNetworkError } from '@/lib/sync';

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

export const useRapportsStore = create<RapportsState>((set) => ({
  snapshot: null,
  snapshotLoading: false,
  offline: false,
  offlineSince: null,
  stockVelocity: [],
  velocityLoading: false,

  fetchReportsSnapshot: async (businessId, periodDays, role, userId, today) => {
    set({ snapshotLoading: true });
    const { data, error } = await supabase.rpc('get_reports_snapshot', {
      p_business_id: businessId,
      p_period_days: periodDays,
      p_role:        role,
      p_user_id:     userId,
      p_today:       today ?? new Date().toISOString().split('T')[0],
    });
    if (error || !data) {
      if (isNetworkError(error)) {
        const cached = await getRapportsCache(businessId);
        if (cached) {
          const ts = await getCacheTimestamp('rapports_cache', businessId);
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
    void saveRapportsCache(businessId, data);
    set({ snapshot: parseSnapshot(data as Record<string, unknown>), snapshotLoading: false, offline: false, offlineSince: null });
  },

  fetchStockVelocity: async (businessId) => {
    set({ velocityLoading: true });
    const { data, error } = await supabase.rpc('get_stock_velocity', {
      p_business_id: businessId,
    });
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

  reset: () => set({ snapshot: null, snapshotLoading: false, offline: false, offlineSince: null, stockVelocity: [], velocityLoading: false }),
}));
