// The Accueil hero speaks ONLY on genuine gains; otherwise it renders nothing.
// A flat day ("Même niveau qu'hier") and a weak month total ("Ce mois : 20 GNF")
// both read as anxiety, not information — the owner already knows. This file is
// the one place that decides what, if anything, sits under the Aujourd'hui amount.

export type HomeComparison =
  | { kind: 'welcome' }      // the business has never made a real sale
  | { kind: 'first_sale' }   // today is the day of that first real sale
  | { kind: 'pill' }         // today beat yesterday: the gain pill
  | { kind: 'month' }        // evening/night: "Ce mois : X", only when month is ahead
  | { kind: 'none' };        // flat or down day, weak month: say nothing

/** "Ce mois" is shown only when this month's revenue is STRICTLY greater than last month's. */
export function showMonthLine(monthRevenue: number, lastMonthRevenue: number): boolean {
  return monthRevenue > lastMonthRevenue;
}

export function homeComparison(o: {
  hasEverSold: boolean;
  isFirstSaleToday: boolean;
  isEvening: boolean;
  /** today's revenue minus yesterday's */
  delta: number;
  monthRevenue: number;
  lastMonthRevenue: number;
}): HomeComparison {
  if (!o.hasEverSold) return { kind: 'welcome' };
  if (o.isFirstSaleToday) return { kind: 'first_sale' };
  if (o.isEvening) return showMonthLine(o.monthRevenue, o.lastMonthRevenue) ? { kind: 'month' } : { kind: 'none' };
  return o.delta > 0 ? { kind: 'pill' } : { kind: 'none' };
}
