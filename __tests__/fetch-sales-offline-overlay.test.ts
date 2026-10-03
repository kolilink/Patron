// stores/ventes.ts fetchSales — the offline error path must NOT wipe the
// just-written offline sales that refreshPendingOverlay already merged at
// the top of the function. Before this fix, a network failure re-seeded
// `sales` from the raw ventes_cache (which never contains the outbox), so a
// pending credit sale vanished from every consumer that reads after the
// fetch resolves (home KPIs via loadKpis).
//
// The fix: in the isNetworkError branch, when isDefaultScope is true, re-
// apply the overlay (its baseline is the untouched cache) and set only the
// offline flags. For non-default (status-filtered) scope, the raw-cache
// behavior is kept — the overlay is scope-specific and must not leak into
// filtered views.
//
// lib/pendingOverlay.ts and lib/sync.ts are NOT mocked here — their real
// projector and retry logic run, so this is a genuine integration check of
// the store wiring.

const mockGetVentesCache = jest.fn();
const mockGetAllQueueItemsForOverlay = jest.fn();
const mockGetCacheTimestamp = jest.fn();

jest.mock('@/lib/db', () => ({
    getVentesCache: mockGetVentesCache,
    getAllQueueItemsForOverlay: mockGetAllQueueItemsForOverlay,
    getCacheTimestamp: mockGetCacheTimestamp,
    saveVentesCache: jest.fn(),
    enqueue: jest.fn(),
    getQueueCount: jest.fn().mockResolvedValue(0),
}));

// A chainable query builder mirroring how ventes.ts builds its query
// (.from().select().eq().order()) — every .then() resolves to a network-
// shaped failure so withNetworkRetry confirms the outage and returns it.
const NETWORK_ERROR = { message: 'Failed to fetch', code: '', details: '', hint: '' };
function makeFailingQueryBuilder() {
    const builder: any = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        gte: () => builder,
        limit: () => builder,
        then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
            Promise.resolve({ data: null, error: NETWORK_ERROR }).then(resolve, reject),
    };
    return builder;
}

jest.mock('@/lib/supabase', () => ({
    supabase: { rpc: jest.fn(), from: jest.fn(() => makeFailingQueryBuilder()) },
}));
jest.mock('@/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/lib/posthog', () => ({ posthog: null }));
jest.mock('@/stores/sync', () => ({ useSyncStore: { getState: () => ({ kick: jest.fn() }) } }));
jest.mock('@/src/utils/notifications', () => ({ notifyEvent: jest.fn() }));

let mockSession: unknown = null;
jest.mock('@/stores/auth', () => ({
    useAuthStore: { getState: () => ({ session: mockSession }) },
}));

import { useVentesStore } from '@/stores/ventes';
import { getAllQueueItemsForOverlay } from '@/lib/db';

function pendingCarnetDebtOp(id: number, idempotencyKey: string) {
    return {
        id, operation: 'submit_carnet_debt', status: 'pending', attempts: 0, last_error: null,
        idempotency_key: idempotencyKey, entity_type: 'dette',
        queued_at: '2026-09-28T10:00:00.000Z', created_at: '2026-09-28T10:00:00.000Z',
        // 1000000 cents = 10000 display units — a credit sale against biz-1.
        payload: JSON.stringify({ p_business_id: 'biz-1', p_seller_id: 'user-1', p_customer_name: 'Aissatou', p_amount: 1000000 }),
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    useVentesStore.setState({ sales: [], loading: false, offline: false, offlineSince: null, salesFetchedFor: null, error: null });
    mockSession = {
        activeBusiness: { id: 'biz-1' },
        activeMembership: { role: 'administrateur' },
        user: { id: 'user-1' },
    };
    mockGetVentesCache.mockResolvedValue([]);
    mockGetAllQueueItemsForOverlay.mockResolvedValue({ ok: [], corrupt: [] });
    mockGetCacheTimestamp.mockResolvedValue(null);
});

describe('fetchSales — offline error path keeps the pending overlay (default scope)', () => {
    it('a pending credit sale survives a failing network fetch (not wiped by the raw cache)', async () => {
        mockGetAllQueueItemsForOverlay.mockResolvedValue({
            ok: [pendingCarnetDebtOp(1, 'debt-1')],
            corrupt: [],
        });

        await useVentesStore.getState().fetchSales('biz-1', undefined);

        const state = useVentesStore.getState();
        const pending = state.sales.find(s => s.id === 'debt-1');
        expect(pending).toBeDefined();
        expect(pending!.status).toBe('credit');
        expect(pending!.is_credit).toBe(true);
        // The offline flags are set, and the fetch is marked resolved.
        expect(state.offline).toBe(true);
        expect(state.salesFetchedFor).toBe('biz-1');
    });
});

describe('fetchSales — offline error path keeps the raw cache (non-default scope)', () => {
    it('a status-filtered fetch does not fold the pending overlay into the filtered view', async () => {
        const cachedPayeSale = {
            id: 'cached-paye', business_id: 'biz-1', customer_name: 'Test', client_id: null,
            seller_id: 'user-1', seller_name: 'Fatou', status: 'paye', is_credit: false,
            total_amount: 2000, discount_amount: 0, amount_paid: 2000, paid_at: '2026-09-01T00:00:00.000Z',
            sale_date: '2026-09-01', created_at: '2026-09-01T00:00:00.000Z', cancelled_at: null,
            cancellation_reason: null, edit_count: 0, last_edited_at: null, profit: null,
        };
        mockGetVentesCache.mockImplementation((key: string) =>
            Promise.resolve(key === 'biz-1:all:paye' ? [cachedPayeSale] : []),
        );
        // Even with a pending credit sale in the outbox, the filtered view must
        // not see it.
        mockGetAllQueueItemsForOverlay.mockResolvedValue({
            ok: [pendingCarnetDebtOp(1, 'debt-1')],
            corrupt: [],
        });

        await useVentesStore.getState().fetchSales('biz-1', undefined, undefined, undefined, 'paye');

        const state = useVentesStore.getState();
        expect(state.sales.map(s => s.id)).toEqual(['cached-paye']);
        expect(state.sales.find(s => s.id === 'debt-1')).toBeUndefined();
        expect(state.offline).toBe(true);
    });
});
