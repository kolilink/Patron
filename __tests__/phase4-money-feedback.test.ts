// SWEEP FIX — Phase 4: money feedback gaps. TEST DB only — do not commit.
//
// Hermetic source-level pin (same approach as silent-failures-surfaced and
// destructive-confirm-dialogs — no native modules, runs in `npm test`).
// Asserts the four Phase 4 fixes are wired into source:
//   1. Carnet PayModal exposes an editable date field.
//   2. Ventes PaymentSheet starts empty with a "Tout régler : X" tap-to-fill.
//   3. Withdrawals are editable — migration_v224 edit_withdrawal RPC + store
//      action + apports UI routing/dispatch.
//   4. Correction flow: vendeurs already have cancel_sale (verified, skipped).
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');

function readSource(rel: string): string {
    return readFileSync(join(ROOT, rel), 'utf8');
}

describe('Phase 4 — money feedback gaps', () => {
    it('carnet PayModal exposes an editable DatePickerField (clients/[name].tsx)', () => {
        const src = readSource('app/(app)/clients/[name].tsx');
        // The date state already existed but was never shown; now the field is rendered.
        expect(src).toMatch(/function PayModal\(/);
        expect(src).toMatch(/<DatePickerField label="Date" value=\{date\} onChange=\{setDate\} maxToday \/>/);
    });

    it('ventes PaymentSheet starts empty + "Tout régler : X" tap-to-fill (ventes/index.tsx)', () => {
        const src = readSource('app/(app)/ventes/index.tsx');
        // Starts empty, deliberately — no default full-amount prefill.
        expect(src).toMatch(/function PaymentSheet\(/);
        expect(src).toMatch(/if \(visible\) \{\s*setAmountStr\(''\);\s*setMethod\('especes'\);\s*setDate\(todayISO\(\)\);\s*\}/);
        // The tap-to-fill label now carries the amount, matching the carnet.
        expect(src).toMatch(/Tout régler : \{fmt\(remaining, currency\)\}/);
        // The useEffect no longer prefills `remaining` — only the onPress
        // tap-to-fill button (outside the effect) reaches for formatAmountInput.
        expect(src).not.toMatch(/useEffect\(\(\) => \{\s*if \(visible\) \{[\s\S]{0,200}?formatAmountInput/);
    });

    it('stores/apports.ts exposes editWithdrawal via edit_withdrawal RPC', () => {
        const src = readSource('stores/apports.ts');
        expect(src).toMatch(/editWithdrawal: \(params: \{/);
        expect(src).toMatch(/editWithdrawal: async \(\{ id, businessId, amount, injectedById, sourceName, note, withdrawnAt \}\)/);
        expect(src).toMatch(/supabase\.rpc\('edit_withdrawal', \{/);
        expect(src).toMatch(/p_id: id,/);
        expect(src).toMatch(/p_amount: Math\.round\(amount \* 100\),/);
    });

    it('apports/index.tsx routes withdrawals to an editable mode and dispatches editWithdrawal', () => {
        const src = readSource('app/(app)/apports/index.tsx');
        // The form-mode union now includes an editable withdrawal mode.
        expect(src).toMatch(/'editWithdrawal'/);
        expect(src).toMatch(/editWithdrawal: 'Modifier le retrait'/);
        // Withdrawals now open editable instead of read-only view.
        expect(src).toMatch(/const openEditWithdrawal = \(apport: Apport\) => \{[\s\S]*?setFormMode\('editWithdrawal'\)/);
        expect(src).toMatch(/if \(apport\.amount < 0\) openEditWithdrawal\(apport\);/);
        // handleSave dispatches the new store action for the editable mode.
        expect(src).toMatch(/formMode === 'editWithdrawal' && editingApport/);
        expect(src).toMatch(/await editWithdrawal\(\{[\s\S]*?withdrawnAt: rest\.injectedAt,/);
        expect(src).toMatch(/message = 'Retrait modifié';/);
    });

    it('migration_v224.sql defines edit_withdrawal with withdrawal-only + positive-amount guards', () => {
        const src = readSource('db/migration_v224.sql');
        expect(src).toMatch(/CREATE OR REPLACE FUNCTION public\.edit_withdrawal\(/);
        expect(src).toMatch(/IF v_amount >= 0 THEN[\s\S]*?n''est pas un retrait/);
        expect(src).toMatch(/IF get_role\(v_business_id\) NOT IN \('administrateur', 'manager'\) THEN/);
        expect(src).toMatch(/IF p_amount <= 0 THEN[\s\S]*?Le montant doit être positif/);
        expect(src).toMatch(/amount\s*=\s*-p_amount,/);
        expect(src).toMatch(/edited_at\s*=\s*now\(\),/);
        expect(src).toMatch(/GRANT EXECUTE ON FUNCTION public\.edit_withdrawal\(uuid, bigint, uuid, text, text, date\) TO authenticated;/);
    });
});
