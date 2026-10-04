// SWEEP FIX — Phase 1.4: the products store parses get_product_stats (v222)
// profit as `number | null`, preserving the server's NULL when profit is
// untrustworthy. The catalogue "Rentabilité" sheet then renders "—" instead
// of a fabricated margin. This pins the parse contract client-side: a NULL
// profit stays null (not 0), while money fields still divide by 100.
import { randomUUID } from 'crypto';

const mockRpc = jest.fn();
jest.mock('@/lib/supabase', () => ({
    supabase: { rpc: mockRpc },
}));

jest.mock('@/lib/sync', () => ({
    isNetworkError: jest.fn(() => false),
    withTimeout: jest.fn((p: unknown) => p),
    withNetworkRetry: jest.fn((fn: () => unknown) => fn()),
    reportOfflineFallback: jest.fn(),
}));

jest.mock('@/lib/db', () => ({
    saveProductCache: jest.fn().mockResolvedValue(undefined),
    getProductCache: jest.fn().mockResolvedValue(null),
    enqueue: jest.fn(),
    getQueueCount: jest.fn().mockResolvedValue(0),
    getCacheTimestamp: jest.fn().mockResolvedValue(null),
}));

jest.mock('@/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/lib/haptics', () => ({ haptics: { success: jest.fn(), error: jest.fn(), tap: jest.fn() } }));
jest.mock('@/src/utils/notifications', () => ({ notifyEvent: jest.fn() }));
jest.mock('@/stores/sync', () => ({
    useSyncStore: { getState: () => ({ pendingCount: 0 }) },
}));

import { useProductStore } from '@/stores/products';

beforeEach(() => {
    jest.clearAllMocks();
});

describe('ProductStats — profit null-parse (Phase 1.4, v222)', () => {
    it('preserves a NULL profit as null (never coerced to 0)', async () => {
        mockRpc.mockResolvedValue({
            data: { revenue: 400000, capital: 0, linked_expenses: 0, profit: null },
            error: null,
        });

        const stats = await useProductStore.getState().fetchProductStats(
            randomUUID(), 'biz-1', undefined,
        );

        expect(stats).not.toBeNull();
        expect(stats!.profit).toBeNull();
        // Money fields still divided by 100.
        expect(stats!.revenue).toBe(4000);
        expect(stats!.capital).toBe(0);
    });

    it('divides a numeric profit by 100', async () => {
        mockRpc.mockResolvedValue({
            data: { revenue: 400000, capital: 100000, linked_expenses: 0, profit: 300000 },
            error: null,
        });

        const stats = await useProductStore.getState().fetchProductStats(
            randomUUID(), 'biz-1', undefined,
        );

        expect(stats!.profit).toBe(3000);
    });

    it('returns null when the RPC itself errors (no fabricated stats)', async () => {
        mockRpc.mockResolvedValue({ data: null, error: { message: 'boom' } });

        const stats = await useProductStore.getState().fetchProductStats(
            randomUUID(), 'biz-1', undefined,
        );

        expect(stats).toBeNull();
    });
});
