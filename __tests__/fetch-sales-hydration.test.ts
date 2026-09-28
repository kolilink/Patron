// §6 of the offline-first rewrite: fetchSales (stores/ventes.ts) must seed
// from cache + the pending-outbox overlay BEFORE the live network query
// resolves, not after — this is the literal hydration-order requirement
// ("cache -> overlay -> render -> background refresh") the approved plan
// specifies, and it's what makes a cold start after a kill (acceptance
// test #3) show real, current data instantly instead of a blank/loading
// screen that only fills in once (and if) the network responds.
//
// Verified here by holding the live query's own promise open (never
// resolving it during the assertion) and confirming the local
// cache+overlay content is already reflected in `sales` regardless.

jest.mock('@/lib/db', () => ({
  getVentesCache: jest.fn(),
  getAllQueueItemsForOverlay: jest.fn().mockResolvedValue({ ok: [], corrupt: [] }),
  saveVentesCache: jest.fn().mockResolvedValue(undefined),
  getCacheTimestamp: jest.fn().mockResolvedValue(null),
  enqueue: jest.fn(),
  getQueueCount: jest.fn().mockResolvedValue(0),
}));

jest.mock('@/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/lib/posthog', () => ({ posthog: null }));

// A chainable mock matching how ventes.ts builds its query
// (.from().select().eq().order()) — resolves only when the test explicitly
// releases it, so we can assert on state while the "network" is still in flight.
let releaseQuery: ((v: unknown) => void) | null = null;
function makeHangingQueryBuilder() {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    order: () => builder,
    gte: () => builder,
    limit: () => builder,
    then: (resolve: (v: unknown) => void) => { releaseQuery = resolve; },
  };
  return builder;
}

jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: jest.fn(() => makeHangingQueryBuilder()),
  },
}));

import { useVentesStore } from '@/stores/ventes';
import { useAuthStore } from '@/stores/auth';
import { getVentesCache } from '@/lib/db';

beforeEach(() => {
  jest.clearAllMocks();
  releaseQuery = null;
  useVentesStore.setState({ sales: [], loading: false, salesFetchedFor: null });
  useAuthStore.setState({
    session: { user: { id: 'user-1' }, activeBusiness: { id: 'biz-1' }, activeMembership: { role: 'administrateur' } },
  } as any);
});

describe('fetchSales — hydration order (§6)', () => {
  it('reflects cached data in `sales` before the live network query ever resolves', async () => {
    const cachedSale = { id: 'cached-1', business_id: 'biz-1', customer_name: 'Test', client_id: null,
      seller_id: 'user-1', seller_name: 'Fatou', status: 'credit', is_credit: true,
      total_amount: 5000, discount_amount: 0, amount_paid: 0, paid_at: null,
      sale_date: '2026-09-01', created_at: '2026-09-01T00:00:00.000Z', cancelled_at: null,
      cancellation_reason: null, edit_count: 0, last_edited_at: null, profit: null };
    (getVentesCache as jest.Mock).mockResolvedValue([cachedSale]);

    // Deliberately not awaited — fetchSales is a single async function
    // that internally awaits the live query, so awaiting it here would
    // always include that wait. We want to observe the state DURING the
    // in-flight network call, which the un-released hanging builder above
    // guarantees never completes within this test.
    const fetchPromise = useVentesStore.getState().fetchSales('biz-1', undefined);

    // Flush microtasks so the cache-seed step (which the real code awaits
    // before ever starting the network query) has had a chance to run,
    // without waiting for the network query itself, which is still hanging.
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    expect(useVentesStore.getState().sales.map(s => s.id)).toContain('cached-1');
    expect(releaseQuery).not.toBeNull(); // confirms the network call genuinely hasn't resolved yet

    // Clean up: release the hanging query so the promise doesn't leak past this test.
    releaseQuery?.({ data: [], error: null });
    await fetchPromise.catch(() => {});
  });
});
