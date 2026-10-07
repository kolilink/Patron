// Warm EVERY offline read cache while the app is online, not only the one for the
// tab the user happens to open. A cache used to be written only when its own
// screen first fetched — so a vendor who opened Accueil + Vendre online and then
// went offline found Fournisseurs / Dépenses "Ouvrez l'application en ligne une
// première fois" even though she had been online all day. That message must mean
// NEVER FETCHED, not "wrong tab".
//
// Sequential and gentle (cheap phones): one store at a time, behind the first
// paint. Stores that already fetched this business this session are skipped —
// their own fetch has already written the cache.
import { useAuthStore } from '@/stores/auth';
import { useProductStore } from '@/stores/products';
import { useVentesStore } from '@/stores/ventes';
import { useFournisseursStore } from '@/stores/fournisseurs';
import { useExpensesStore } from '@/stores/expenses';
import { isKnownOffline } from '@/lib/connectivity';
import { warmupTargetsFor } from '@/src/utils/cacheWarmupTargets';

export async function warmCaches(): Promise<string[]> {
  const warmed: string[] = [];
  if (isKnownOffline()) return warmed;
  const s = useAuthStore.getState().session;
  const businessId = s?.activeBusiness?.id;
  if (!s || !businessId) return warmed;
  const userId = s.user.id;
  const role = s.activeMembership?.role;
  const membershipId = s.activeMembership?.id;
  const targets = warmupTargetsFor(role);

  const run = async (name: string, fn: () => Promise<unknown>) => {
    if (isKnownOffline()) return;
    try { await fn(); warmed.push(name); } catch (err) { console.warn(`[warmup] ${name} failed`, err); }
  };

  if (useProductStore.getState().productsFetchedFor !== businessId) {
    await run('products', () => useProductStore.getState().fetchProducts(businessId, userId, membershipId, role));
  }
  if (useVentesStore.getState().salesFetchedFor !== businessId) {
    await run('ventes', () => useVentesStore.getState().fetchSales(businessId, role === 'vendeur' ? userId : undefined));
  }
  if (targets.fournisseurs) {
    await run('fournisseurs', () => useFournisseursStore.getState().fetchFournisseurs(businessId));
    await run('commandes', () => useFournisseursStore.getState().fetchCommandes(businessId));
  }
  if (targets.expenses) {
    await run('expenses', () => useExpensesStore.getState().fetchExpenses(businessId));
  }
  return warmed;
}
