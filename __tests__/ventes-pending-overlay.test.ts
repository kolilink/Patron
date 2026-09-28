// stores/ventes.ts's refreshPendingOverlay — the shared merge step every
// Phase-1 write path calls. Two properties matter most: (1) it scopes to
// the acting user's real role, mirroring fetchSales's own vendeur-vs-admin
// convention, so a vendeur can never have another seller's sales folded in
// via this mechanism; (2) it never double-applies a pending mutation, since
// its baseline always comes from the untouched ventes_cache, never from
// whatever's already rendered in memory (a real bug caught and fixed
// while writing this — see stores/ventes.ts's own comment on why).
//
// lib/pendingOverlay.ts itself is NOT mocked here — its real projector/
// allocation logic runs, so this is a genuine integration check of the
// store wiring, not just a call-was-made assertion.

const mockGetVentesCache = jest.fn();
const mockGetAllQueueItemsForOverlay = jest.fn();

jest.mock('@/lib/db', () => ({
  getVentesCache: mockGetVentesCache,
  getAllQueueItemsForOverlay: mockGetAllQueueItemsForOverlay,
  saveVentesCache: jest.fn(),
  getCacheTimestamp: jest.fn(),
  enqueue: jest.fn(),
  getQueueCount: jest.fn().mockResolvedValue(0),
}));

jest.mock('@/lib/supabase', () => ({ supabase: { rpc: jest.fn(), from: jest.fn() } }));
jest.mock('@/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/lib/posthog', () => ({ posthog: null }));
jest.mock('@/stores/sync', () => ({ useSyncStore: { getState: () => ({ kick: jest.fn() }) } }));
jest.mock('@/src/utils/notifications', () => ({ notifyEvent: jest.fn() }));

let mockSession: unknown = null;
jest.mock('@/stores/auth', () => ({
  useAuthStore: { getState: () => ({ session: mockSession }) },
}));

import { useVentesStore, type Vente } from '@/stores/ventes';

function baseVente(overrides: Partial<Vente> = {}): Vente {
  return {
    id: 'synced-1', business_id: 'biz-1', customer_name: 'Aissatou', client_id: null,
    seller_id: 'user-1', seller_name: 'Fatou', status: 'credit', is_credit: true,
    total_amount: 10000, discount_amount: 0, amount_paid: 0,
    paid_at: null, sale_date: '2026-09-01', created_at: '2026-09-01T10:00:00.000Z',
    cancelled_at: null, cancellation_reason: null, edit_count: 0, last_edited_at: null, profit: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  useVentesStore.setState({ sales: [] });
});

describe('refreshPendingOverlay — role scoping', () => {
  it('a vendeur reads the per-seller cache key, never the all-sellers one', async () => {
    mockSession = {
      activeBusiness: { id: 'biz-1' },
      activeMembership: { role: 'vendeur' },
      user: { id: 'user-1' },
    };
    mockGetVentesCache.mockResolvedValueOnce([]);
    mockGetAllQueueItemsForOverlay.mockResolvedValueOnce({ ok: [], corrupt: [] });

    await useVentesStore.getState().refreshPendingOverlay();

    expect(mockGetVentesCache).toHaveBeenCalledWith('biz-1:user-1');
  });

  it('an administrateur reads the all-sellers cache key', async () => {
    mockSession = {
      activeBusiness: { id: 'biz-1' },
      activeMembership: { role: 'administrateur' },
      user: { id: 'user-1' },
    };
    mockGetVentesCache.mockResolvedValueOnce([]);
    mockGetAllQueueItemsForOverlay.mockResolvedValueOnce({ ok: [], corrupt: [] });

    await useVentesStore.getState().refreshPendingOverlay();

    expect(mockGetVentesCache).toHaveBeenCalledWith('biz-1:all');
  });

  it('with no active session, it is a safe no-op (no cache read, no crash)', async () => {
    mockSession = null;
    await useVentesStore.getState().refreshPendingOverlay();
    expect(mockGetVentesCache).not.toHaveBeenCalled();
  });
});

describe('refreshPendingOverlay — no double-application across repeated calls', () => {
  it('calling it twice with the same still-queued payment allocates it only once, not twice', async () => {
    mockSession = {
      activeBusiness: { id: 'biz-1' },
      activeMembership: { role: 'administrateur' },
      user: { id: 'user-1' },
    };
    // The cache (real synced truth) never changes across these two calls —
    // the payment hasn't synced yet, so the server-side amount_paid is
    // genuinely still 0. Only the in-memory `sales` (via `set` inside the
    // action) would have been wrong if the baseline had come from there.
    mockGetVentesCache.mockResolvedValue([baseVente({ amount_paid: 0 })]);
    mockGetAllQueueItemsForOverlay.mockResolvedValue({
      ok: [{
        id: 1, operation: 'record_client_payment', status: 'pending', attempts: 0, last_error: null,
        idempotency_key: null, entity_type: 'paiement', queued_at: '2026-09-28T10:00:00.000Z', created_at: '2026-09-28T10:00:00.000Z',
        // 1000000 cents = 10000 display units — exactly the sale's own
        // total_amount (also display units), so a single correct
        // allocation fully settles it and a doubled one would overpay
        // past what's owed, which allocateClientPayment's own cap already
        // forbids — making a silent double-application visible either way
        // (either amount_paid would double, or status would stay 'credit'
        // when it should read 'paye').
        payload: JSON.stringify({ p_business_id: 'biz-1', p_customer_name: 'Aissatou', p_amount: 1000000, p_method: 'especes', p_date: '2026-09-28' }),
      }],
      corrupt: [],
    });

    await useVentesStore.getState().refreshPendingOverlay();
    const firstResult = useVentesStore.getState().sales.find(s => s.id === 'synced-1')!;
    expect(firstResult.amount_paid).toBe(10000); // fully settles the 10000-unit sale
    expect(firstResult.status).toBe('paye');

    await useVentesStore.getState().refreshPendingOverlay();
    const secondResult = useVentesStore.getState().sales.find(s => s.id === 'synced-1')!;
    // Same value both times — not doubled. This is the property that
    // matters: if the second call had used the (already-patched) in-memory
    // `sales` as its baseline instead of re-reading the untouched cache,
    // amount_paid would have grown a second time here.
    expect(secondResult.amount_paid).toBe(firstResult.amount_paid);
  });
});
