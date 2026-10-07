import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { isKnownOffline } from '@/lib/connectivity';
import { getAllQueueItemsForOverlay, getClientLedgerCache, saveClientLedgerCache } from '@/lib/db';
import { withTimeout } from '@/lib/sync';
import { useVentesStore } from '@/stores/ventes';
import { useSyncStore } from '@/stores/sync';
import {
  mergeQuickClients, pendingNameActivity, salesNameActivity,
  type NameActivity, type QuickClient,
} from '@/src/utils/quickClients';

export type { QuickClient };

// Bounded on purpose (not a full sale-history scan) — cheap via the existing
// idx_sale_orders_client_id index (migration_v42.sql), and 300 recent rows is
// plenty to rank recency for a quick-picker.
const RECENT_SALES_LIMIT = 300;

async function readPendingNames(businessId: string): Promise<NameActivity[]> {
  try {
    const { ok } = await getAllQueueItemsForOverlay();
    const ops = ok.flatMap(i => {
      try { return [{ operation: i.operation, payload: JSON.parse(i.payload) as Record<string, unknown>, queuedAt: i.queued_at ?? null, status: i.status }]; }
      catch { return []; }
    });
    return pendingNameActivity(ops, businessId);
  } catch {
    return [];
  }
}

// The picker's list is LOCAL truth first (src/utils/quickClients.ts): the last
// ranked list seen online + the customer names on the sales this phone holds +
// names recorded offline that haven't synced yet. The server list merges in the
// background when online. So a name recorded a second ago is in the picker at
// once — offline, or with the network call still in flight — and never needs
// retyping; and nothing in here ever waits on a network timeout to show usable UI.
//
// Ranks by recency of the last sale/credit entry, most-recent first, falling back
// to alphabetical for clients with no history. Used by CreditRapideCapture and
// vendre.tsx's credit "Qui" phase.
export function useQuickClients(businessId: string | undefined, refreshKey?: unknown) {
  const [server, setServer] = useState<QuickClient[]>([]);
  const [pending, setPending] = useState<NameActivity[]>([]);
  const [loading, setLoading] = useState(false);
  // Business id the list was last resolved for. `loaded` is derived from it
  // rather than stored as a boolean, so a business switch reads as "not
  // loaded" on the very same render — no effect-delay frame where the old
  // business's (or an empty) list could paint as if it were final.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  const sales = useVentesStore(s => s.sales);
  const pendingCount = useSyncStore(s => s.pendingCount);

  // Pending names track the outbox live: recording a credit (count changes) shows the
  // name immediately, with no refetch and no refreshKey bump needed.
  useEffect(() => {
    if (!businessId) { setPending([]); return; }
    let cancelled = false;
    void readPendingNames(businessId).then(p => { if (!cancelled) setPending(p); });
    return () => { cancelled = true; };
  }, [businessId, pendingCount, refreshKey]);

  useEffect(() => {
    if (!businessId) { setServer([]); return; }
    let cancelled = false;
    setLoading(true);

    (async () => {
      const cacheKey = `quickclients:${businessId}`;
      // Local first, instantly: the pending names, then the last server list seen
      // online (or nothing → the sales-derived names below, or "Nouveau").
      const pendingNow = await readPendingNames(businessId);
      if (!cancelled) setPending(pendingNow);
      try {
        const cached = await getClientLedgerCache(cacheKey);
        if (!cancelled && Array.isArray(cached)) setServer(cached as QuickClient[]);
      } catch { /* no cache is fine */ }
      if (cancelled) return;
      setLoadedFor(businessId);
      // Known offline: never touch the network — what we have IS the answer.
      if (isKnownOffline()) { setLoading(false); return; }
      try {
        const [clientRes, saleRes] = await withTimeout(Promise.all([
          supabase.from('clients').select('id, name, phone').eq('business_id', businessId),
          supabase
            .from('sale_orders')
            .select('client_id, created_at')
            .eq('business_id', businessId)
            .not('client_id', 'is', null)
            .order('created_at', { ascending: false })
            .limit(RECENT_SALES_LIMIT),
        ]), 6000);
        if (cancelled) return;
        // A returned error must never replace a good (cached) list with an empty one.
        if (clientRes.error || saleRes.error) return;
        const clientRows = clientRes.data;
        const saleRows = saleRes.data;

        const lastActivity = new Map<string, string>();
        for (const row of (saleRows ?? []) as { client_id: string; created_at: string }[]) {
          if (!lastActivity.has(row.client_id)) lastActivity.set(row.client_id, row.created_at);
        }
        const ranked = ((clientRows ?? []) as QuickClient[]).slice().sort((a, b) => {
          const aAt = a.id ? lastActivity.get(a.id) : undefined;
          const bAt = b.id ? lastActivity.get(b.id) : undefined;
          if (aAt && bAt) return aAt < bAt ? 1 : -1;
          if (aAt) return -1;
          if (bAt) return 1;
          return a.name.localeCompare(b.name);
        });
        setServer(ranked);
        void saveClientLedgerCache(cacheKey, ranked);   // the SERVER list only — pending names are merged at read time
      } catch {
        // Keep whatever list we already have.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [businessId, refreshKey]);

  const clients = useMemo(
    () => mergeQuickClients({
      server,
      sales: businessId ? salesNameActivity(sales.filter(s => s.business_id === businessId)) : [],
      pending,
    }),
    [server, sales, pending, businessId],
  );

  return { clients, loading, loaded: !!businessId && loadedFor === businessId };
}
