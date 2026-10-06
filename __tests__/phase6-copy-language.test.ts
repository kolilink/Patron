// SWEEP FIX — Phase 6: copy & language. TEST DB only — do not commit.
//
// Hermetic source-level pin (same approach as phase5-misleading-screens) — no
// native modules, runs in `npm test`. Asserts each Phase 6 fix is wired into
// source. Copy assertions are cheap here: reading files and matching strings.
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');

function readSource(rel: string): string {
    return readFileSync(join(ROOT, rel), 'utf8');
}

describe('Phase 6 — copy & language', () => {
    it('6.1 stores/auth.ts wraps the 4 raw-English auth errors in translateError', () => {
        const src = readSource('stores/auth.ts');
        // createPhoneVerification, loginWithPhone, verifyPhoneCode, sendEmailOtp
        // (recoverByEmail also translates — that's a bonus, not a regression)
        const matches = src.match(/error: translateError\(err, raw\)/g) ?? [];
        expect(matches.length).toBeGreaterThanOrEqual(4);
        // "Network request failed" must never leak through raw — the setter is
        // always translated, so no raw-English assignment remains.
        expect(src).not.toMatch(/error:\s*raw/);
    });

    it('6.2 clientReminder.ts drops the tu/vous clash (Bonjour + commerce)', () => {
        const src = readSource('src/utils/clientReminder.ts');
        expect(src).toMatch(/Bonjour \$\{name\},/);
        expect(src).toMatch(/Vous pouvez passer au commerce/);
        expect(src).not.toMatch(/Salut \$\{name\}/);
        expect(src).not.toMatch(/à la boutique/);
    });

    it('6.3 vendre.tsx says "vous devra", kills the dead cancel link + sync badge, and surfaces the rabais', () => {
        const src = readSource('app/(app)/(tabs)/vendre.tsx');
        expect(src).toMatch(/et vous devra \$\{formatAmount\(creditRemaining, currency\)\}/);
        expect(src).toMatch(/vous devra \$\{formatAmount\(creditRemaining, currency\)\}/);
        expect(src).not.toMatch(/te devra/);
        // Dead cancel path removed: the confirm sheet's link is now a plain Ignorer.
        expect(src).not.toMatch(/Annuler la vente/);
        expect(src).not.toMatch(/confirmSaleId/);
        expect(src).not.toMatch(/confirmQueued/);
        // Banned sync badge deleted.
        expect(src).not.toMatch(/En attente de synchronisation/);
        // Rabais surfaced + "Un crédit" radio gated on isShort.
        expect(src).toMatch(/La différence sera notée comme un rabais\./);
        expect(src).toMatch(/\{isShort && \(/);
    });

    it('6.4 partenaire stock.tsx uses friendly copy with a Réessayer button', () => {
        const src = readSource('app/(app)/partenaire/[partnership_id]/stock.tsx');
        expect(src).toMatch(/Impossible de charger le stock pour le moment\. Réessayez\./);
        expect(src).toMatch(/Réessayer/);
        expect(src).not.toMatch(/rpcErr\.message/);
    });

    it('6.5 parametres/index.tsx titles account deletion "Supprimer mon compte ?"', () => {
        const src = readSource('app/(app)/parametres/index.tsx');
        expect(src).toMatch(/Supprimer mon compte \?/);
    });

    it('6.6 verrouille.tsx says "Déverrouillez Patron pour continuer."', () => {
        const src = readSource('app/(auth)/verrouille.tsx');
        expect(src).toMatch(/Déverrouillez Patron pour continuer\./);
        expect(src).not.toMatch(/Regardez votre téléphone pour continuer\./);
    });

    it('6.7 the staff join flows no longer route into Amis (attribution is silent, in (app)/_layout)', () => {
        const welcome = readSource('app/(welcome)/rejoindre.tsx');
        const onboarding = readSource('app/(app)/onboarding/rejoindre.tsx');
        for (const src of [welcome, onboarding]) {
            expect(src).not.toMatch(/discussions\?tab=amis/);
            expect(src).toMatch(/joinBusiness\(/);
        }
        expect(readSource('app/(app)/_layout.tsx')).toMatch(/recordPendingInviteAttribution\(\)/);
    });

    it('6.8 onboarding carnet, accueil and plus copy fixes', () => {
        expect(readSource('app/(app)/onboarding/carnet.tsx')).toMatch(/L'argent qu'on me doit/);
        expect(readSource('app/(app)/(tabs)/index.tsx')).toMatch(/Votre commerce est prêt !/);
        const plus = readSource('app/(app)/(tabs)/plus.tsx');
        expect(plus).toMatch(/'Investisseur'/);
        expect(plus).toMatch(/'Gérant adjoint'/);
        expect(plus).not.toMatch(/'Observateur'/);
    });

    it('6.9 recuperation.tsx binds emailOtpLoading (not the session loading flag) and PhoneInput label is explicit', () => {
        const recup = readSource('app/(welcome)/recuperation.tsx');
        expect(recup).toMatch(/emailOtpLoading/);
        expect(recup).toMatch(/loading=\{emailOtpLoading\}/);
        expect(readSource('src/components/ui/PhoneInput.tsx')).toMatch(/Pays ou code du pays/);
    });
});
