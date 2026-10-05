// SWEEP FIX — Phase 1.2: get_period_report now returns `sales_without_cost`
// (distinct orders whose lines have cost_price_at_sale IS NULL, v220) and the
// store parses it onto PeriodReport. The rapports hero renders two honest
// captions from it — "hors X ventes sans prix d'achat" (when > 0) and "dont X
// de crédit pas encore payé" (when credit_outstanding > 0) — so Bénéfice cumulé
// no longer reads as pure cash-in-hand with no caveats.
//
// This test pins the parse contract client-side: a real RPC payload's new
// field must land on yearReport.sales_without_cost (a count, not cents), while
// the money fields stay divided by 100.

jest.mock('@/lib/sync', () => ({
    isNetworkError: jest.fn(() => false),
    withTimeout: jest.fn((p: unknown) => p),
    withNetworkRetry: jest.fn((fn: () => unknown) => fn()),
    reportOfflineFallback: jest.fn(),
}));

jest.mock('@/lib/db', () => ({
    saveRapportsCache: jest.fn().mockResolvedValue(undefined),
    getRapportsCache: jest.fn().mockResolvedValue(null),
    getCacheTimestamp: jest.fn().mockResolvedValue(null),
}));

const rpc = jest.fn();
jest.mock('@/lib/supabase', () => ({
    supabase: { rpc },
}));

// The store pairs every report with the outbox; these suites don't exercise that
// (see rapports-read-side.test.ts), so keep the heavy store graph out.
jest.mock('@/stores/ventes', () => ({ useVentesStore: { getState: () => ({ sales: [] }), subscribe: () => () => {} } }));
jest.mock('@/stores/sync', () => ({ useSyncStore: { getState: () => ({ syncing: false }), subscribe: () => () => {} } }));

let mockSession: unknown = null;
jest.mock('@/stores/auth', () => ({
    useAuthStore: { getState: () => ({ session: mockSession }) },
}));

import { useRapportsStore } from '@/stores/rapports';

const PERIOD_PAYLOAD = {
    role: 'administrateur',
    period_start: '2026-01-01',
    period_end: '2026-12-31',
    cash_on_hand: 1200000,          // 12 000
    net_profit: 450000,             // 4 500
    sales_count: 7,
    units_sold: 30,
    sales_without_cost: 3,          // the new v220 field — a COUNT, not cents
    credit_outstanding: 80000,      // 800
    credit_count: 2,
    daily: [],
    my_sales_count: 0,
    my_units_sold: 0,
    my_credit_pending: 0,
    my_credit_count: 0,
    my_daily: [],
    investor_balance: 0,
    my_total_invested: 0,
};

beforeEach(() => {
    jest.clearAllMocks();
    mockSession = { activeBusiness: { id: 'biz-1' } };
    useRapportsStore.setState({
        yearReport: null, yearReportLoading: false,
        previousYearReport: null, previousYearReportLoading: false,
        filterReport: null, filterReportLoading: false,
        periodOffline: false, periodOfflineSince: null,
    });
});

describe('PeriodReport — sales_without_cost parse (Phase 1.2)', () => {
    it('parses the new count field as a plain number (not ÷100)', async () => {
        rpc.mockResolvedValue({ data: PERIOD_PAYLOAD, error: null });

        await useRapportsStore.getState().fetchYearReport('biz-1', 2026, 'administrateur', 'user-1');

        const report = useRapportsStore.getState().yearReport;
        expect(report).not.toBeNull();
        expect(report?.sales_without_cost).toBe(3);
    });

    it('still divides money fields by 100 alongside the new count', async () => {
        rpc.mockResolvedValue({ data: PERIOD_PAYLOAD, error: null });

        await useRapportsStore.getState().fetchYearReport('biz-1', 2026, 'administrateur', 'user-1');

        const report = useRapportsStore.getState().yearReport;
        expect(report?.net_profit).toBe(4500);
        expect(report?.credit_outstanding).toBe(800);
        expect(report?.cash_on_hand).toBe(12000);
    });

    it('defaults sales_without_cost to 0 when absent (older cached payloads)', async () => {
        const { sales_without_cost: _omit, ...legacy } = PERIOD_PAYLOAD;
        rpc.mockResolvedValue({ data: legacy, error: null });

        await useRapportsStore.getState().fetchYearReport('biz-1', 2026, 'administrateur', 'user-1');

        expect(useRapportsStore.getState().yearReport?.sales_without_cost).toBe(0);
    });
});
