// Post-drain integrity check for the numbers Accueil shows.
//
// Once a sync has fully settled (outbox empty, a server read taken AFTER the
// last drain), "server base + outbox" collapses to the server base — so the
// figures the sales list derives locally (salesKpisFromList) must equal the
// server's. If they don't, a displayed number is wrong: that must be LOUD
// (logged, reported) and self-healing (forced refetch), never silent.
//
// Only the fields that are exact regardless of how much history the local sales
// list holds are compared: today's count and today's cash revenue (today's sales
// are always inside any fetch window). Credit totals depend on the whole
// receivable history, which a windowed list may not carry, so they are not
// asserted here.
export interface IntegrityFields {
  sales_today: number;
  revenue_today: number;
}

const TOLERANCE = 0.011; // one centime of display-unit rounding

export function compareServerToLocal(server: IntegrityFields, local: IntegrityFields): string[] {
  const issues: string[] = [];
  if (server.sales_today !== local.sales_today) issues.push('sales_today');
  if (Math.abs(server.revenue_today - local.revenue_today) > TOLERANCE) issues.push('revenue_today');
  return issues;
}
