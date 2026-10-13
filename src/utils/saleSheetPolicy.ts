// Post-action confirmations never block the primary flow. After Encaisser the vendor stays on the grid, ready for
// the next customer: a floating pill + haptic IS the confirmation. The one exception is the FIRST sale ever — the
// activation moment that teaches her the app works — which keeps the celebration sheet (with "Partager le reçu").
import { getKV, setKV } from '@/lib/db';

export const celebrationKey = (businessId: string) => `first_sale_celebration_${businessId}`;

/** Pure rule. Unknown history (sales not loaded yet) is treated as "not the first" — never block a rush sale on a guess. */
export function shouldShowSaleSheet(o: { skipConfirmSheet: boolean; celebrationSeen: boolean; salesLoaded: boolean; priorSales: number }): boolean {
  if (o.skipConfirmSheet || o.celebrationSeen) return false;
  return o.salesLoaded && o.priorSales === 0;
}

export async function hasSeenCelebration(businessId: string): Promise<boolean> {
  try { return (await getKV(celebrationKey(businessId))) === '1'; } catch { return true; /* failure: silent — on doubt, no sheet */ }
}
export async function markCelebrationSeen(businessId: string): Promise<void> {
  try { await setKV(celebrationKey(businessId), '1'); } catch { /* failure: silent — worst case the sheet shows once more */ }
}
