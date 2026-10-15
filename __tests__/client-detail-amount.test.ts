// Client carnet amount fix (Part 1). Three root causes, three fixes, pinned
// at the two layers this repo tests at:
//   * behavioral — selectClientSales (src/utils/salesTotals.ts) is the exact
//     pure function the screen runs, so the offline-created-credit matching is
//     proven here against the real code, not a copy of its formula;
//   * source pins — the screen wiring in app/(app)/clients/[name].tsx and the
//     navigation hand-off in app/(app)/clients/index.tsx, the same hermetic
//     approach as the other screen pins in this repo.
//
// (a) an offline-created credit (client_id = null) is matched by name even when
//     the screen routes by client UUID — via the seeded displayName.
// (b) the full-screen loading gate no longer waits on the payments network read.
// (c) only the banner AMOUNT slot is gated, not the whole page.
// (d) the "payments resolved" flag is set on every terminal path of the read.
// (e) the clients list passes `displayName` alongside the UUID.
// (f) hardening: the "no sales" early return also resolves payments.

import { readFileSync } from 'fs';
import { join } from 'path';

import { selectClientSales } from '@/src/utils/salesTotals';

const DETAIL = readFileSync(join(__dirname, '..', 'app/(app)/clients/[name].tsx'), 'utf8');
const LIST = readFileSync(join(__dirname, '..', 'app/(app)/clients/index.tsx'), 'utf8');

const UUID = '00000000-0000-4000-8000-000000000001';

const creditSale = (over: Record<string, unknown> = {}) => ({
    id: 'sale-1',
    status: 'credit',
    is_credit: true,
    total_amount: 16500,
    discount_amount: 0,
    amount_paid: 0,
    created_at: '2026-06-20T00:00:00Z',
    customer_name: 'Aïssatou',
    client_id: null,
    ...over,
});

describe('selectClientSales — offline-created credits match by name (a)', () => {
    it('an id-routed screen with a seeded displayName matches a client_id=null credit by name', () => {
        const sales = [creditSale()];
        expect(selectClientSales(sales, UUID, true, 'Aïssatou')).toHaveLength(1);
    });

    it('the same id-routed screen with NO displayName (the old empty-seed bug) missed the credit', () => {
        const sales = [creditSale()];
        expect(selectClientSales(sales, UUID, true, '')).toHaveLength(0);
    });

    it('a credit with a real client_id matches directly, no name needed', () => {
        const sales = [creditSale({ client_id: UUID })];
        expect(selectClientSales(sales, UUID, true, '')).toHaveLength(1);
    });

    it('a client_id=null row with a DIFFERENT name is not dragged in by the seeded name', () => {
        const sales = [
            creditSale({ client_id: null, customer_name: 'Aïssatou' }),
            creditSale({ id: 'sale-2', client_id: null, customer_name: 'Someone else' }),
        ];
        // name fallback only matches rows whose customer_name equals the seeded displayName
        expect(selectClientSales(sales, UUID, true, 'Aïssatou')).toHaveLength(1);
    });
});

describe('the carnet screen no longer blanks on a slow payments read', () => {
    it('(b) full-screen loading gate waits on the SALES store + empty list, never on the payments read', () => {
        // `loading` (the store) AND no client sales — the old `loadingLocal && loading`
        // gate waited on loadLedgerPaymentsServer and blanked the whole screen.
        expect(DETAIL).toMatch(/if \(loading && clientSales\.length === 0\)/);
        expect(DETAIL).not.toMatch(/if \(loadingLocal && loading\)/);
    });

    it('(c) only the banner amount slot is gated by the payments placeholder', () => {
        const banner = DETAIL.slice(DETAIL.indexOf('{totalOwed > 0 ?'), DETAIL.indexOf('{totalOwed > 0 ?') + 700);
        expect(banner).toMatch(/!paymentsResolved && allPayments\.length === 0 \?/);
        // The full page renders around it — the gate is inside the banner, not around the screen.
        // (Since 2026-10-14 the placeholder is the animated LoadingStatus, per the loading law.)
        expect(banner).toMatch(/<LoadingStatus word="Chargement"/);
        // The amount text is rendered inside the same banner's else-branch.
        expect(banner).toMatch(/amount=\{totalOwed\}/);
    });

    it('(d) paymentsResolved is set on every terminal path of the payments read', () => {
        const fn = DETAIL.slice(DETAIL.indexOf('const loadLedgerPaymentsServer'), DETAIL.indexOf('const loadLedgerLines'));
        // early return (no sales), returned error, success, and the thrown-timeout catch.
        expect((fn.match(/setPaymentsResolved\(true\)/g) ?? [])).toHaveLength(4);
    });

    it('(f) the "no sales" early return resolves payments too (no permanent placeholder)', () => {
        const fn = DETAIL.slice(DETAIL.indexOf('const loadLedgerPaymentsServer'), DETAIL.indexOf('const loadLedgerLines'));
        expect(fn).toMatch(/if \(clientSales\.length === 0\) \{ setLoadingLocal\(false\); setPaymentsResolved\(true\); return; \}/);
    });
});

describe('the clients list hands the name alongside the UUID', () => {
    it('(e) both the row press and the WhatsApp reminder pass displayName', () => {
        expect(LIST).toMatch(/params: \{ name: item\.clientId \?\? item\.name, displayName: item\.name \}/);
        expect(LIST).toMatch(/params: \{ name: client\.clientId \?\? client\.name, displayName: client\.name, remind: '1' \}/);
    });
});
