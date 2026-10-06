import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { saveRapportsCache, getRapportsCache, getCacheTimestamp } from '@/lib/db';
import { isNetworkError, withTimeout, withNetworkRetry, reportOfflineFallback } from '@/lib/sync';
import { useAuthStore } from '@/stores/auth';
import { useVentesStore } from '@/stores/ventes';
import { useSyncStore } from '@/stores/sync';
import {
  rebuildPendingOverlay, buildReportDelta,
  type OverlayContext, type OverlaySale, type PendingPaymentEvent, type ReportDelta,
} from '@/lib/pendingOverlay';
import { translateError } from '@/lib/errors';

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
// rolling period_days — see db/migration_v162.sql's header note.
export interface PeriodReport {
  role: string;
  period_start: string;
  period_end: string;
  // Admin / manager / investisseur
  cash_on_hand: number;
  net_profit: number;
  sales_count: number;
  units_sold: number;
  // Number of distinct paye/credit orders in the period with ≥1 line whose
  // cost_price_at_sale is NULL — those lines' revenue is excluded from
  // net_profit (see db/migration_v220.sql), surfaced as a caveat on the hero.
  sales_without_cost: number;
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
  // Explicit error slots. Unknown is never zero: a screen decides loading /
  // fresh / stale / error / empty from data-presence + these, never from values.
  snapshotError: string | null;
  yearReportError: string | null;
  filterReportError: string | null;
  /** Re-pairs every displayed report with the CURRENT outbox (after a local write). */
  refreshOverlay: () => Promise<void>;
  fetchYearReport: (
    businessId: string,
    year: number,
    role: string,
    userId: string,
  ) => Promise<void>;
  // Previous full calendar year — fetched only to power the "vs l'an dernier"
  // delta on the profit hero. Own slot, not reused off `yearReport`, since
  // both need to be on screen at once (current year headline + the
  // comparison baseline it's measured against).
  previousYearReport: PeriodReport | null;
  previousYearReportLoading: boolean;
  fetchPreviousYearReport: (
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
      date: pt.date,
      amount: pt.amount / 100,
    }));
  const parseSellers = (): TopSeller[] =>
    ((raw['top_sellers'] as Array<{ name: string; revenue: number; count: number }>) ?? []).map(s => ({
      name: s.name,
      revenue: s.revenue / 100,
      count: s.count,
    }));

  return {
    role: (raw['role'] as string) ?? '',
    period_days: (raw['period_days'] as number) ?? 0,
    period_start: (raw['period_start'] as string) ?? '',
    revenue: cents('revenue'),
    cogs: cents('cogs'),
    stock_losses: cents('stock_losses'),
    gross_profit: cents('gross_profit'),
    operating_expenses: cents('operating_expenses'),
    shipping_expenses: cents('shipping_expenses'),
    net_profit: cents('net_profit'),
    credit_outstanding: cents('credit_outstanding'),
    credit_count: (raw['credit_count'] as number) ?? 0,
    period_order_count: (raw['period_order_count'] as number) ?? 0,
    cash_on_hand: cents('cash_on_hand'),
    stock_value: cents('stock_value'),
    total_apports: cents('total_apports'),
    period_apports: cents('period_apports'),
    activity: parseActivity('activity'),
    top_sellers: parseSellers(),
    my_revenue: cents('my_revenue'),
    my_sales_count: (raw['my_sales_count'] as number) ?? 0,
    my_credit_pending: cents('my_credit_pending'),
    my_credit_count: (raw['my_credit_count'] as number) ?? 0,
    my_activity: parseActivity('my_activity'),
    investor_balance: cents('investor_balance'),
    my_total_invested: cents('my_total_invested'),
    my_period_apports: cents('my_period_apports'),
  };
}

function parsePeriodReport(raw: Record<string, unknown>): PeriodReport {
  const cents = (k: string) => ((raw[k] as number) ?? 0) / 100;
  const parseDaily = (key: string): DailyPoint[] =>
    ((raw[key] as Array<{ date: string; amount: number; sales_count: number; units_sold: number }>) ?? []).map(pt => ({
      date: pt.date,
      amount: pt.amount / 100,
      sales_count: pt.sales_count,
      units_sold: pt.units_sold,
    }));

  return {
    role: (raw['role'] as string) ?? '',
    period_start: (raw['period_start'] as string) ?? '',
    period_end: (raw['period_end'] as string) ?? '',
    cash_on_hand: cents('cash_on_hand'),
    net_profit: cents('net_profit'),
    sales_count: (raw['sales_count'] as number) ?? 0,
    units_sold: (raw['units_sold'] as number) ?? 0,
    sales_without_cost: (raw['sales_without_cost'] as number) ?? 0,
    credit_outstanding: cents('credit_outstanding'),
    credit_count: (raw['credit_count'] as number) ?? 0,
    daily: parseDaily('daily'),
    my_sales_count: (raw['my_sales_count'] as number) ?? 0,
    my_units_sold: (raw['my_units_sold'] as number) ?? 0,
    my_credit_pending: cents('my_credit_pending'),
    my_credit_count: (raw['my_credit_count'] as number) ?? 0,
    my_daily: parseDaily('my_daily'),
    investor_balance: cents('investor_balance'),
    my_total_invested: cents('my_total_invested'),
  };
}

// ─── Base + overlay ──────────────────────────────────────────────────────────
// Every displayed report is `base + delta`: base = the last server (or cached)
// report, untouched; delta = what the still-unsynced outbox adds
// (lib/pendingOverlay.ts buildReportDelta). Bases are kept here, module-level;
// the store's public fields (snapshot / yearReport / …) hold the DISPLAYED,
// paired result and nothing else.
//
// PAIRING RULE: a base is only ever shown with an overlay captured at the same
// moment. A fresh base with a stale overlay is what double-counts during a
// drain (the server already counted the sale, the old overlay still adds it).
// So: (1) the overlay is read right after the base is stored, in the same
// set() that publishes the result; (2) a fetch during which the outbox changed
// (or a drain was running) is discarded and retried — the response can't be
// tied to one outbox state; (3) a later local write only ADDS to the paired
// overlay (items drained since stay in it until the next refetch replaces the
// base), so a drain finishing never opens a gap or a double-count; (4) a
// finished drain triggers a refetch of every shown report.

type SlotName = 'snapshot' | 'year' | 'previousYear' | 'filter';

interface Pairing { sales: OverlaySale[]; payments: PendingPaymentEvent[]; keys: Set<string> }

interface SlotEntry {
  base: ReportsSnapshot | PeriodReport;
  pairing: Pairing;
  start: string;
  end: string;
  role: string;
  userId: string;
}

const slots: Partial<Record<SlotName, SlotEntry>> = {};
const refetchers: Partial<Record<SlotName, () => Promise<void>>> = {};
const MAX_PAIR_ATTEMPTS = 3;
const SYNC_IDLE_WAIT_MS = 4000;

function overlayContext(): OverlayContext {
  const session = useAuthStore.getState().session;
  return {
    currentUserId: session?.user.id ?? null,
    currentUserName: session?.user.name ?? '',
    currentBusinessId: session?.activeBusiness?.id ?? null,
  };
}

async function readPairing(): Promise<Pairing> {
  // Baseline [] on purpose: only NEW pending sales and payment events come out.
  // If the outbox itself can't be read, the report still loads: base only (it
  // understates by what is queued, never invents or double-counts).
  let sales: OverlaySale[] = [];
  let payments: PendingPaymentEvent[] = [];
  try {
    ({ sales, payments } = await rebuildPendingOverlay([], overlayContext()));
  } catch { /* outbox unreadable → empty overlay */ }
  const pending = sales.filter(s => s._pending);
  return { sales: pending, payments, keys: new Set([...pending.map(s => s.id), ...payments.map(p => p.id)]) };
}

function sameKeys(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const k of a) if (!b.has(k)) return false;
  return true;
}

// Later local writes only add; anything already paired stays (latest version if
// it is still queued, the paired copy if it has drained since).
function extendPairing(paired: Pairing, now: Pairing): Pairing {
  const nowSales = new Map(now.sales.map(s => [s.id, s]));
  const sales = paired.sales.map(s => nowSales.get(s.id) ?? s);
  for (const s of now.sales) if (!paired.keys.has(s.id)) sales.push(s);
  const nowPay = new Map(now.payments.map(p => [p.id, p]));
  const payments = paired.payments.map(p => nowPay.get(p.id) ?? p);
  for (const p of now.payments) if (!paired.keys.has(p.id)) payments.push(p);
  return { sales, payments, keys: new Set([...paired.keys, ...now.keys]) };
}

async function waitForIdleSync(): Promise<void> {
  const deadline = Date.now() + SYNC_IDLE_WAIT_MS;
  while (useSyncStore.getState().syncing && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}

// Runs `run` (the server fetch) bracketed by two outbox reads. Returns the
// result with the overlay it is valid against; retries when the outbox moved.
export async function fetchPaired<R>(run: () => Promise<R>, isFailure: (r: R) => boolean): Promise<{ result: R; pairing: Pairing }> {
  let last: { result: R; pairing: Pairing } | null = null;
  for (let attempt = 0; attempt < MAX_PAIR_ATTEMPTS; attempt++) {
    await waitForIdleSync();
    const before = await readPairing();
    const result = await run();
    if (isFailure(result)) return { result, pairing: before };
    const after = await readPairing();
    last = { result, pairing: after };
    if (!useSyncStore.getState().syncing && sameKeys(before.keys, after.keys)) return last;
  }
  // Still unstable after retries: pair with the outbox as it is now. Residual
  // risk is a single sample (gap or double) that the post-drain refetch repairs.
  return last as { result: R; pairing: Pairing };
}

const dayOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function mergeDaily(base: DailyPoint[], delta: ReportDelta['daily']): DailyPoint[] {
  if (delta.size === 0) return base;
  const byDate = new Map(base.map(p => [p.date, { ...p }]));
  for (const [date, d] of delta) {
    const cur = byDate.get(date) ?? { date, amount: 0, sales_count: 0, units_sold: 0 };
    cur.amount += d.amount; cur.sales_count += d.salesCount; cur.units_sold += d.unitsSold;
    byDate.set(date, cur);
  }
  return [...byDate.values()].sort((x, y) => x.date.localeCompare(y.date));
}

function mergeActivity(base: ActivityPoint[], delta: Map<string, number> | ReportDelta['daily']): ActivityPoint[] {
  if (delta.size === 0) return base;
  const byDate = new Map(base.map(p => [p.date, { ...p }]));
  for (const [date, v] of delta) {
    const amount = typeof v === 'number' ? v : v.amount;
    const cur = byDate.get(date) ?? { date, amount: 0 };
    cur.amount += amount;
    byDate.set(date, cur);
  }
  return [...byDate.values()].sort((x, y) => x.date.localeCompare(y.date));
}

/** Period report (year / filter / previous year) = base + delta. Profit is never touched: pending cost is unknown. */
export function applyDeltaToPeriodReport(base: PeriodReport, d: ReportDelta, isVendeur: boolean): PeriodReport {
  if (isVendeur) {
    return {
      ...base,
      my_sales_count: base.my_sales_count + d.my.salesCount,
      my_units_sold: base.my_units_sold + d.my.unitsSold,
      my_credit_pending: Math.max(0, base.my_credit_pending + d.my.creditDelta),
      my_credit_count: Math.max(0, base.my_credit_count + d.my.creditCountDelta),
      my_daily: mergeDaily(base.my_daily, d.my.daily),
    };
  }
  return {
    ...base,
    sales_count: base.sales_count + d.salesCount,
    units_sold: base.units_sold + d.unitsSold,
    sales_without_cost: base.sales_without_cost + d.pendingWithoutCost,
    cash_on_hand: base.cash_on_hand + d.cashDelta,
    credit_outstanding: Math.max(0, base.credit_outstanding + d.creditDelta),
    credit_count: Math.max(0, base.credit_count + d.creditCountDelta),
    daily: mergeDaily(base.daily, d.daily),
  };
}

/** Rolling snapshot (Accueil / ReportsSnapshot consumers) = base + delta. */
export function applyDeltaToSnapshot(base: ReportsSnapshot, d: ReportDelta, isVendeur: boolean): ReportsSnapshot {
  if (isVendeur) {
    return {
      ...base,
      my_revenue: base.my_revenue + d.my.revenue,
      my_sales_count: base.my_sales_count + d.my.salesCount,
      my_credit_pending: Math.max(0, base.my_credit_pending + d.my.creditDelta),
      my_credit_count: Math.max(0, base.my_credit_count + d.my.creditCountDelta),
      my_activity: mergeActivity(base.my_activity, d.my.activity),
    };
  }
  const staff = new Map(base.top_sellers.map(t => [t.name, { ...t }]));
  for (const t of d.staffSellers.values()) {
    const cur = staff.get(t.name) ?? { name: t.name, revenue: 0, count: 0 };
    cur.revenue += t.revenue; cur.count += t.count;
    staff.set(t.name, cur);
  }
  return {
    ...base,
    revenue: base.revenue + d.revenue,
    period_order_count: base.period_order_count + d.salesCount,
    cash_on_hand: base.cash_on_hand + d.cashDelta,
    credit_outstanding: Math.max(0, base.credit_outstanding + d.creditDelta),
    credit_count: Math.max(0, base.credit_count + d.creditCountDelta),
    activity: mergeActivity(base.activity, d.daily),
    top_sellers: [...staff.values()].sort((a, b) => b.revenue - a.revenue),
  };
}

function displayEntry(slot: SlotName, e: SlotEntry): ReportsSnapshot | PeriodReport {
  const delta = buildReportDelta(
    { sales: e.pairing.sales, payments: e.pairing.payments },
    { start: e.start, end: e.end, currentUserId: e.userId },
  );
  const isVendeur = e.role === 'vendeur';
  return slot === 'snapshot'
    ? applyDeltaToSnapshot(e.base as ReportsSnapshot, delta, isVendeur)
    : applyDeltaToPeriodReport(e.base as PeriodReport, delta, isVendeur);
}

const STATE_KEY: Record<SlotName, 'snapshot' | 'yearReport' | 'previousYearReport' | 'filterReport'> = {
  snapshot: 'snapshot', year: 'yearReport', previousYear: 'previousYearReport', filter: 'filterReport',
};

async function refreshOverlayImpl(): Promise<void> {
  const names = (Object.keys(slots) as SlotName[]).filter(n => slots[n]);
  if (names.length === 0) return;
  const now = await readPairing();
  const patch: Record<string, unknown> = {};
  for (const n of names) {
    const e = slots[n]!;
    e.pairing = extendPairing(e.pairing, now);
    patch[STATE_KEY[n]] = displayEntry(n, e);
  }
  useRapportsStore.setState(patch as Partial<RapportsState>);
}

// Cache reads are decrypt/parse-safe in lib/db.ts (null on any failure); this
// adds the shape check, so a cache that parses but is the wrong thing (schema
// change, half-written) is treated as NO cache — never zeros, never a crash.
function validRaw(raw: unknown): raw is Record<string, unknown> {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw)
    && typeof (raw as Record<string, unknown>)['role'] === 'string'
    && typeof (raw as Record<string, unknown>)['period_start'] === 'string';
}

async function readCacheSafe(key: string): Promise<unknown | null> {
  try { return await getRapportsCache(key); } catch { return null; }
}

function safeParse<T>(raw: unknown, parse: (r: Record<string, unknown>) => T): T | null {
  if (!validRaw(raw)) return null;
  try { return parse(raw); } catch { return null; }
}

// Shared by fetchYearReport/fetchFilterReport/fetchPreviousYearReport.
async function loadPeriodReport(
  businessId: string, periodStart: string, periodEnd: string, role: string, userId: string,
  set: (partial: Partial<RapportsState>) => void,
  slot: 'year' | 'filter' | 'previousYear',
): Promise<void> {
  const loadingKey = slot === 'year' ? 'yearReportLoading' : slot === 'filter' ? 'filterReportLoading' : 'previousYearReportLoading';
  const dataKey = STATE_KEY[slot];
  const errorKey = slot === 'year' ? 'yearReportError' : slot === 'filter' ? 'filterReportError' : null;
  refetchers[slot] = () => loadPeriodReport(businessId, periodStart, periodEnd, role, userId, set, slot);
  set({ [loadingKey]: true, ...(errorKey ? { [errorKey]: null } : {}) } as Partial<RapportsState>);

  const cacheKey = `${businessId}:${role}:${userId}:${periodStart}:${periodEnd}`;
  const { result, pairing } = await fetchPaired(
    () => withNetworkRetry(() =>
      supabase.rpc('get_period_report', {
        p_business_id: businessId,
        p_period_start: periodStart,
        p_period_end: periodEnd,
        p_role: role,
        p_user_id: userId,
      }),
    ).catch(err => ({ data: null, error: err })),
    r => !!r.error || !r.data,
  );
  if (isStaleBusiness(businessId)) return;
  const { data, error } = result;
  const entryFor = (base: PeriodReport, p: Pairing): SlotEntry => ({ base, pairing: p, start: periodStart, end: periodEnd, role, userId });

  if (error || !data) {
    const network = isNetworkError(error);
    if (network) reportOfflineFallback('rapports.loadPeriodReport', error);
    const base = safeParse(await readCacheSafe(cacheKey), parsePeriodReport);
    if (isStaleBusiness(businessId)) return;
    if (base) {
      // Stale but real: last known report + the outbox as it is now.
      const cur = pairing; // read just before the failed request — offline nothing drains, so it is current
      const entry = entryFor(base, cur);
      slots[slot] = entry;
      const ts = await getCacheTimestamp('rapports_cache', cacheKey);
      if (isStaleBusiness(businessId)) return;
      set({
        [dataKey]: displayEntry(slot, entry),
        [loadingKey]: false,
        periodOffline: true,
        periodOfflineSince: ts,
        ...(errorKey ? { [errorKey]: null } : {}),
      } as Partial<RapportsState>);
      return;
    }
    // No (usable) cache. Network → the offline view; anything else → an error
    // view with Réessayer. Neither shows numbers.
    delete slots[slot];
    set({
      [dataKey]: null,
      [loadingKey]: false,
      ...(network
        ? { periodOffline: true, periodOfflineSince: null, ...(errorKey ? { [errorKey]: null } : {}) }
        : (errorKey ? { [errorKey]: translateError(error ?? new Error('empty'), 'Impossible de charger les chiffres') } : {})),
    } as Partial<RapportsState>);
    return;
  }

  const base = safeParse(data, parsePeriodReport);
  if (!base) {
    set({
      [loadingKey]: false,
      ...(errorKey ? { [errorKey]: 'Réponse inattendue du serveur' } : {}),
    } as Partial<RapportsState>);
    return;
  }
  void saveRapportsCache(cacheKey, data);
  const entry = entryFor(base, pairing);
  slots[slot] = entry;
  set({
    [dataKey]: displayEntry(slot, entry),
    [loadingKey]: false,
    periodOffline: false,
    periodOfflineSince: null,
    ...(errorKey ? { [errorKey]: null } : {}),
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
  previousYearReport: null,
  previousYearReportLoading: false,
  filterReport: null,
  filterReportLoading: false,
  periodOffline: false,
  periodOfflineSince: null,
  snapshotError: null,
  yearReportError: null,
  filterReportError: null,
  refreshOverlay: () => refreshOverlayImpl(),

  fetchReportsSnapshot: async (businessId, periodDays, role, userId, today) => {
    refetchers.snapshot = () => useRapportsStore.getState().fetchReportsSnapshot(businessId, periodDays, role, userId, today);
    set({ snapshotLoading: true, snapshotError: null });
    // rapports_cache's `business_id` column is a plain TEXT PRIMARY KEY (no FK),
    // so it doubles as a generic cache key here — packing in periodDays/role/userId
    // is a value-only change, no migration needed. Role and user are in the key so
    // a vendeur's personal figures and an admin's full-business figures are never
    // served from each other's slot on a shared device (the overlay is scoped by
    // the same role/user, so both layers agree).
    const cacheKey = `${businessId}:${role}:${userId}:${periodDays}`;
    const todayIso = today ?? new Date().toISOString().split('T')[0];
    const { result, pairing } = await fetchPaired(
      () => withNetworkRetry(() =>
        supabase.rpc('get_reports_snapshot', {
          p_business_id: businessId,
          p_period_days: periodDays,
          p_role: role,
          p_user_id: userId,
          p_today: todayIso,
        }),
      ).catch(err => ({ data: null, error: err })),
      r => !!r.error || !r.data,
    );
    if (isStaleBusiness(businessId)) return;
    const { data, error } = result;
    const entryFor = (base: ReportsSnapshot, p: Pairing): SlotEntry => ({
      base, pairing: p, start: base.period_start || dayOf(new Date()), end: dayOf(new Date()), role, userId,
    });

    if (error || !data) {
      const network = isNetworkError(error);
      if (network) reportOfflineFallback('rapports.fetchReportsSnapshot', error);
      const base = safeParse(await readCacheSafe(cacheKey), parseSnapshot);
      if (isStaleBusiness(businessId)) return;
      if (base) {
        const entry = entryFor(base, pairing);
        slots.snapshot = entry;
        const ts = await getCacheTimestamp('rapports_cache', cacheKey);
        if (isStaleBusiness(businessId)) return;
        set({ snapshot: displayEntry('snapshot', entry) as ReportsSnapshot, snapshotLoading: false, offline: true, offlineSince: ts, snapshotError: null });
        return;
      }
      delete slots.snapshot;
      set(network
        ? { snapshot: null, snapshotLoading: false, offline: true, offlineSince: null }
        : { snapshot: null, snapshotLoading: false, snapshotError: translateError(error ?? new Error('empty'), 'Impossible de charger les chiffres') });
      return;
    }

    const base = safeParse(data, parseSnapshot);
    if (!base) { set({ snapshotLoading: false, snapshotError: 'Réponse inattendue du serveur' }); return; }
    void saveRapportsCache(cacheKey, data);
    const entry = entryFor(base, pairing);
    slots.snapshot = entry;
    set({ snapshot: displayEntry('snapshot', entry) as ReportsSnapshot, snapshotLoading: false, offline: false, offlineSince: null, snapshotError: null });
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
        item_id: r['item_id'] as string,
        item_name: r['item_name'] as string,
        stock_qty: r['stock_qty'] as number,
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

  fetchPreviousYearReport: (businessId, year, role, userId) =>
    loadPeriodReport(businessId, `${year - 1}-01-01`, `${year - 1}-12-31`, role, userId, set, 'previousYear'),

  fetchFilterReport: (businessId, periodStart, periodEnd, role, userId) =>
    loadPeriodReport(businessId, periodStart, periodEnd, role, userId, set, 'filter'),

  clearFilterReport: () => {
    delete slots.filter;
    delete refetchers.filter;
    set({ filterReport: null, filterReportLoading: false, filterReportError: null });
  },

  reset: () => {
    for (const k of Object.keys(slots) as SlotName[]) delete slots[k];
    for (const k of Object.keys(refetchers) as SlotName[]) delete refetchers[k];
    useRapportsStore.setState({
    snapshotError: null, yearReportError: null, filterReportError: null,
    snapshot: null, snapshotLoading: false, offline: false, offlineSince: null,
    stockVelocity: [], velocityLoading: false,
    yearReport: null, yearReportLoading: false,
    previousYearReport: null, previousYearReportLoading: false,
    filterReport: null, filterReportLoading: false,
    periodOffline: false, periodOfflineSince: null,
    });
  },
}));

// Keep the displayed pair current. A local write (ventes.sales changes) only
// ADDS to the paired overlay; a finished drain that synced something refetches
// every shown report, replacing base AND overlay together (never one alone).
try {
  if (typeof useVentesStore.subscribe === 'function') {
    useVentesStore.subscribe((state, prev) => {
      if (state.sales !== prev.sales) void refreshOverlayImpl().catch(() => {});
    });
  }
  if (typeof useSyncStore.subscribe === 'function') {
    useSyncStore.subscribe((state, prev) => {
      if (state.lastResult !== prev.lastResult && (state.lastResult?.synced ?? 0) > 0) {
        for (const refetch of Object.values(refetchers)) void refetch?.().catch(() => {});
      }
    });
  }
} catch { /* a test double without subscribe — the explicit refreshOverlay() action still works */ }
