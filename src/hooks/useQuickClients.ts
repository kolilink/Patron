import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { isKnownOffline } from '@/lib/connectivity';
import { getClientLedgerCache, saveClientLedgerCache } from '@/lib/db';
import { withTimeout } from '@/lib/sync';

export interface QuickClient {
  id?: string;
  name: string;
  phone?: string | null;
}

// Bounded on purpose (not a full sale-history scan) — cheap via the existing
// idx_sale_orders_client_id index (migration_v42.sql), and 300 recent rows is
// plenty to rank recency for a quick-picker.
const RECENT_SALES_LIMIT = 300;

// Ranks clients by recency of their last sale/credit entry, most-recent
// first, falling back to alphabetical for clients with no sale history at
// all. Replaces the plain alphabetical sort vendre.tsx's own credit picker
// still uses — a regular buyer should be the first thing tapped, not
// something to scroll/search for.
export function useQuickClients(businessId: string | undefined, refreshKey?: unknown) {
  const [clients, setClients] = useState<QuickClient[]>([]);
  const [loading, setLoading] = useState(false);
  // Business id the list was last resolved for. `loaded` is derived from it
  // rather than stored as a boolean, so a business switch reads as "not
  // loaded" on the very same render — no effect-delay frame where the old
  // business's (or an empty) list could paint as if it were final. `loading`
  // alone can't serve here: it starts false and only flips true inside the
  // effect, i.e. after the first paint.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  useEffect(() => {
    if (!businessId) { setClients([]); return; }
    let cancelled = false;
    setLoading(true);

    (async () => {
      const cacheKey = `quickclients:${businessId}`;
      // Local first, instantly: the last ranked list seen online (or nothing →
      // an empty list, which the picker handles as "Nouveau"). This resolves
      // the first load before any network is involved.
      try {
        const cached = await getClientLedgerCache(cacheKey);
        if (!cancelled && Array.isArray(cached)) {
          setClients(cached as QuickClient[]);
          setLoadedFor(businessId);
        }
      } catch { /* no cache is fine */ }
      if (cancelled) return;
      // Known offline: never touch the network — what we have IS the answer.
      if (isKnownOffline()) {
        setLoading(false); setLoadedFor(businessId);
        return;
      }
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

        setClients(ranked);
        void saveClientLedgerCache(cacheKey, ranked);
      } catch {
        // Keep whatever list we already have; the finally below still marks
        // the first load as resolved so the UI never waits forever.
      } finally {
        if (!cancelled) { setLoading(false); setLoadedFor(businessId); }
      }
    })();

    return () => { cancelled = true; };
  }, [businessId, refreshKey]);

  return { clients, loading, loaded: !!businessId && loadedFor === businessId };
}
