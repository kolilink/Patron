// SWEEP FIX — Phase 3: silent failures must surface a user-facing error.
// TEST DB only — do not commit.
//
// Hermetic source-level pin (same approach as destructive-confirm-dialogs and
// espaces-publics-no-contact tests — no native modules, runs in `npm test`).
// Asserts that every mutating action identified as "silently swallowed" now
// emits a toast.warning / sets store error, and that the call sites which used
// to ignore a `false` return now surface it.
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');

function readSource(rel: string): string {
    return readFileSync(join(ROOT, rel), 'utf8');
}

describe('Phase 3 — silent failures surfaced on mutating actions', () => {
    it('market.ts toggleCommentLike toasts on real errors (silent only for Auto-upvotes)', () => {
        const src = readSource('stores/market.ts');
        expect(src).toMatch(/toggleCommentLike:[\s\S]*?catch\s*\(err\)/);
        expect(src).toMatch(/if\s*\(!msg\.includes\('Auto-upvotes'\)\)\s*\{[\s\S]*?toast\.warning\('Impossible d\\'enregistrer le like\. Réessayez\.'\)/);
        // No bare `catch {` remains on the like/comment-like paths.
        expect(src).not.toMatch(/catch\s*\{\s*\n\s*\/\/\s*Revert all three/);
    });

    it('market.ts addComment toasts before re-throwing', () => {
        const src = readSource('stores/market.ts');
        expect(src).toMatch(/sendingComment: false\s*\}\);\s*toast\.warning\(translateError\(err,\s*'Impossible de publier le commentaire'\)\)/);
    });

    it('fournisseurs.ts updateReceptionSupplier sets error state instead of bare catch', () => {
        const src = readSource('stores/fournisseurs.ts');
        expect(src).toMatch(/updateReceptionSupplier:[\s\S]*?if\s*\(error\)\s*\{[\s\S]*?set\(\{\s*error:\s*message\s*\}\);[\s\S]*?return false;[\s\S]*?\}/);
        expect(src).not.toMatch(/catch\s*\{\s*\n\s*return false;\s*\n\s*\}\s*,\s*\n\s*fetchDebts/);
    });

    it('partnerships.ts loadInviteCode + regenerateInviteCode surface errors', () => {
        const src = readSource('stores/partnerships.ts');
        expect(src).toMatch(/inviteCodeLoading: false,\s*error:\s*translateError\(err,\s*'Impossible de charger le code d\\'invitation'\)/);
        expect(src).toMatch(/inviteCodeLoading: false\s*\}\);\s*toast\.warning\(translateError\(err,\s*'Impossible de régénérer le code d\\'invitation'\)\)/);
    });

    it('equipe/index.tsx surfaces failures for changeRole/removeMembre/revokeCode/updateScopeAll', () => {
        const src = readSource('app/(app)/equipe/index.tsx');
        expect(src).toMatch(/changeRole\(membre\.id,\s*r\)\.then\(ok\s*=>\s*\{[\s\S]*?toast\.warning\(useEquipeStore\.getState\(\)\.error/);
        expect(src).toMatch(/const ok = await removeMembre\(membre\.id\);[\s\S]*?toast\.warning\(useEquipeStore\.getState\(\)\.error/);
        expect(src).toMatch(/revokeCode\(item\.id\)\.then\(ok\s*=>\s*\{[\s\S]*?toast\.warning\(useEquipeStore\.getState\(\)\.error/);
        expect(src).toMatch(/const ok = await updateScopeAll\(membre\.id,\s*val\);/);
        // Phase 4: failures speak in the one vocabulary (what + one action), not a bare toast.
        expect(src).toMatch(/showFailureAlert\(buildFailure\(\{\s*what: FAILURE_COPY\.memberStakesNotSaved\.what/);
    });

    it('catalogue.tsx adjustStock returns boolean and shows success only on ok', () => {
        const productsSrc = readSource('stores/products.ts');
        expect(productsSrc).toMatch(/adjustStock:\s*\([\s\S]*?\)\s*=>\s*Promise<boolean>;/);
        expect(productsSrc).toMatch(/return true;[\s\S]*?return true;[\s\S]*?return false;/);

        const catalogueSrc = readSource('app/(app)/(tabs)/catalogue.tsx');
        expect(catalogueSrc).toMatch(/const ok = await adjustStock\(adjustTarget\.id,\s*businessId,\s*userId,\s*qty,\s*type,\s*note\);/);
        expect(catalogueSrc).toMatch(/if\s*\(ok\)\s*\{[\s\S]*?showSuccess\('Stock ajusté ✓'\);[\s\S]*?\}\s*else\s*\{[\s\S]*?toast\.warning\(useProductStore\.getState\(\)\.error/);
    });

    it('catalogue.tsx handleSave surfaces failure toast', () => {
        const src = readSource('app/(app)/(tabs)/catalogue.tsx');
        expect(src).toMatch(/showFailureAlert\(buildFailure\(\{[\s\S]*?FAILURE_COPY\.productNotSaved\.what/);
    });

    it('marche/[id].tsx and discussions.tsx surface addComment/editMessage failures', () => {
        const marche = readSource('app/(app)/marche/[id].tsx');
        expect(marche).toMatch(/haptics\.error\(\);\s*setText\(trimmed\);\s*failAlert\('commentNotPublished'\);/);

        const disc = readSource('app/(app)/discussions.tsx');
        expect(disc).toMatch(/haptics\.error\(\);[\s\S]*?failAlert\('messageNotEdited'\);/);
    });

    it('fournisseurs/index.tsx surfaces createDebt failure', () => {
        const src = readSource('app/(app)/fournisseurs/index.tsx');
        expect(src).toMatch(/toast\.warning\(useFournisseursStore\.getState\(\)\.error \?\? 'Impossible d\\'enregistrer la dette'\)/);
    });
});
