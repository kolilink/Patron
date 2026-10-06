// Stale-while-revalidate for the Accueil KPIs. The lock screen unmounts the whole
// (app) tree, so after Face ID the dashboard remounts with empty state and used to
// paint a skeleton until the SQLite cache and the network answered. This module
// keeps the numbers that were DISPLAYED (after the outbox overlay) in module
// scope — it survives remounts within the session — so the first paint after
// unlock already has them, and a background refresh updates them underneath.
//
// Keyed by business id: a real business switch never shows another business's
// numbers. Cleared by logout() (stores/auth.ts): a vendeur's role-scoped figures
// must never reach the next user on the same device. Deliberately NOT cleared by
// lock(): a soft lock is the same person coming back.
//
// Lives in its own module (not in the screen file) so the auth store can clear it
// without importing a screen.

let snapshot: { businessId: string; kpis: unknown } | null = null;

export function getKpiSnapshot<T>(businessId: string): T | null {
  return snapshot && businessId && snapshot.businessId === businessId ? (snapshot.kpis as T) : null;
}

export function setKpiSnapshot(businessId: string, kpis: unknown): void {
  if (businessId && kpis) snapshot = { businessId, kpis };
}

export function clearKpiSnapshot(): void {
  snapshot = null;
}
