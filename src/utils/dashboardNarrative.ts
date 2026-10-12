// The Accueil hero speaks ONLY on genuine gains; otherwise it renders nothing.
// A flat day ("Même niveau qu'hier") and a weak month total ("Ce mois : 20 GNF")
// both read as anxiety, not information — the owner already knows. This file is
// the one place that decides what, if anything, sits under the Aujourd'hui amount.

export type HomeComparison =
  | { kind: 'welcome' }      // never made a real sale AND still within WELCOME_WINDOW_DAYS of creation
  | { kind: 'first_sale' }   // today is the day of that first real sale
  | { kind: 'pill' }         // today beat yesterday: the gain pill
  | { kind: 'month' }        // evening/night: "Ce mois : X", only when month is ahead
  | { kind: 'none' };        // flat or down day, weak month: say nothing

/** "Ce mois" is shown only when this month's revenue is STRICTLY greater than last month's. */
export function showMonthLine(monthRevenue: number, lastMonthRevenue: number): boolean {
  return monthRevenue > lastMonthRevenue;
}

/** A welcome is a bridge to the first win, not furniture: after this many days it habituates, then backfires. */
export const WELCOME_WINDOW_DAYS = 7;

/** Whole days since the business was created (0 on day of creation). Unknown creation date → 0 (fail toward showing). */
export function businessAgeDays(createdAt: string | null | undefined, now: Date = new Date()): number {
  if (!createdAt) return 0;
  const t = new Date(createdAt).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

export function homeComparison(o: {
  hasEverSold: boolean;
  /** Whole days since the business was created (see businessAgeDays). Omitted → 0. */
  businessAgeDays?: number;
  isFirstSaleToday: boolean;
  isEvening: boolean;
  /** today's revenue minus yesterday's */
  delta: number;
  monthRevenue: number;
  lastMonthRevenue: number;
}): HomeComparison {
  // Past the window with no paid sale: fall through to the ordinary logic (the line disappears and the space collapses).
  if (!o.hasEverSold && (o.businessAgeDays ?? 0) <= WELCOME_WINDOW_DAYS) return { kind: 'welcome' };
  if (o.isFirstSaleToday) return { kind: 'first_sale' };
  if (o.isEvening) return showMonthLine(o.monthRevenue, o.lastMonthRevenue) ? { kind: 'month' } : { kind: 'none' };
  return o.delta > 0 ? { kind: 'pill' } : { kind: 'none' };
}
