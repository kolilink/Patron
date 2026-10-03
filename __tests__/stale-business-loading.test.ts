// §Task 3 — a fetch that starts for business A but whose business is switched
// mid-flight must never leave the screen stuck on a loading skeleton. The
// guard `isStaleBusiness(businessId)` (activeBusiness.id !== businessId) is
// hoisted to the FIRST line of each fetch, and every mid-fetch early return
// now clears `loading: false` before bailing — so the last writer always
// settles loading to false.
//
// Verified here with a hanging Supabase query builder: we start the fetch for
// biz-1, switch the mocked session to biz-2 while the "network" is still in
// flight, then release the query — and assert `loading` resolves to false
// instead of being left stuck at true.

let resolvers: Array<() => void> = [];

function makeHangingSuccessBuilder(result: unknown) {
    const builder: any = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        then: (resolve: (v: unknown) => void) => {
            resolvers.push(() => resolve(result));
        },
        catch: () => builder,
    };
    return builder;
}

jest.mock('@/lib/supabase', () => ({
    supabase: { from: jest.fn(() => makeHangingSuccessBuilder({ data: [], error: null })) },
}));

jest.mock('@/lib/sync', () => ({
    isNetworkError: jest.fn(() => false),
    withTimeout: jest.fn((p: unknown) => p),
    withNetworkRetry: jest.fn((fn: () => unknown) => fn()),
    reportOfflineFallback: jest.fn(),
}));

jest.mock('@/lib/db', () => ({
    saveFournisseurCache: jest.fn(),
    getFournisseurCache: jest.fn().mockResolvedValue(null),
    saveCommandeCache: jest.fn(),
    getCommandeCache: jest.fn().mockResolvedValue(null),
    getCacheTimestamp: jest.fn().mockResolvedValue(null),
    saveApportsCache: jest.fn(),
    getApportsCache: jest.fn().mockResolvedValue(null),
}));

jest.mock('@/lib/errors', () => ({ translateError: jest.fn((e: unknown) => 'err') }));
jest.mock('@/lib/id', () => ({ generateId: jest.fn(() => 'id'), generateFallbackName: jest.fn(() => 'Membre') }));
jest.mock('@/stores/products', () => ({ useProductStore: { getState: () => ({}) } }));
jest.mock('@/src/utils/notifications', () => ({ notifyEvent: jest.fn() }));

let mockSession: unknown = null;
jest.mock('@/stores/auth', () => ({
    useAuthStore: { getState: () => ({ session: mockSession }) },
}));

import { useFournisseursStore } from '@/stores/fournisseurs';
import { useAportsStore } from '@/stores/apports';

beforeEach(() => {
    jest.clearAllMocks();
    resolvers = [];
    mockSession = { activeBusiness: { id: 'biz-1' } };
    useFournisseursStore.setState({ fournisseurs: [], debts: [], commandes: [], loading: false, offline: false, offlineSince: null, error: null });
    useAportsStore.setState({ apports: [], loading: false, offline: false, offlineSince: null, error: null });
});

describe('fetchFournisseurs — stale business mid-fetch', () => {
    it('resolves loading:false when the business is switched while the network is in flight', async () => {
        const fetchPromise = useFournisseursStore.getState().fetchFournisseurs('biz-1');

        // Flush microtasks so Promise.all has registered its resolvers.
        await Promise.resolve();
        expect(useFournisseursStore.getState().loading).toBe(true);

        // Switch business mid-flight, then release the network.
        mockSession = { activeBusiness: { id: 'biz-2' } };
        resolvers.forEach(r => r());
        await fetchPromise;

        expect(useFournisseursStore.getState().loading).toBe(false);
    });
});

describe('fetchCommandes — stale business mid-fetch', () => {
    it('resolves loading:false when the business is switched while the network is in flight', async () => {
        const fetchPromise = useFournisseursStore.getState().fetchCommandes('biz-1');

        await Promise.resolve();
        expect(useFournisseursStore.getState().loading).toBe(true);

        mockSession = { activeBusiness: { id: 'biz-2' } };
        resolvers.forEach(r => r());
        await fetchPromise;

        expect(useFournisseursStore.getState().loading).toBe(false);
    });
});

describe('fetchApports — stale business mid-fetch', () => {
    it('resolves loading:false when the business is switched while the network is in flight', async () => {
        const fetchPromise = useAportsStore.getState().fetchApports('biz-1');

        // fetchApports seeds from cache first (resolve null -> sets loading:true),
        // then starts the network query. Flush past both awaits.
        await Promise.resolve();
        await Promise.resolve();
        expect(useAportsStore.getState().loading).toBe(true);

        mockSession = { activeBusiness: { id: 'biz-2' } };
        resolvers.forEach(r => r());
        await fetchPromise;

        expect(useAportsStore.getState().loading).toBe(false);
    });
});
