// SWEEP FIX — Phase 5: misleading screens & dead ends. TEST DB only — do not commit.
//
// Hermetic source-level pin (same approach as silent-failures-surfaced and
// phase4-money-feedback — no native modules, runs in `npm test`).
// Asserts the nine Phase 5 fixes are wired into source:
//   5.1 marche/[id].tsx — deleted post shows "Ce post n'existe plus." and hides
//       the comment input (no one types into the void).
//   5.2 discussions.tsx — offline with no cache shows a distinct friends state.
//   5.3 messages/[room_id].tsx — failed DM load shows an error + retry instead of
//       an empty conversation.
//   5.4 ventes/index.tsx — the credit filter is labelled "En dette", not "À payer".
//   5.5 clients/[name].tsx — cash-only client copy says "Aucun crédit pour le moment."
//   5.6 depenses/index.tsx — rejected expenses render a "Refusée" tag (statusPill).
//   5.7 fournisseurs/[id].tsx — supplier delete tells the truth about history and
//       fully-paid debt erasure.
//   5.8 discussions.tsx — "Mon code" toolbar button is always reachable.
//   5.9 app/invite.tsx — invalid/expired token toasts; stores/inviter.ts timeouts.
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');

function readSource(rel: string): string {
    return readFileSync(join(ROOT, rel), 'utf8');
}

describe('Phase 5 — misleading screens & dead ends', () => {
    it('5.1 market.ts tags a missing row (PGRST116) as not_found, not a generic error', () => {
        const src = readSource('stores/market.ts');
        expect(src).toMatch(/detailError: string \| null;/);
        expect(src).toMatch(/const code = \(err as \{ code\?: string \} \| null\)\?\.code;/);
        expect(src).toMatch(/detailError: code === 'PGRST116' \? 'not_found' : 'error'/);
    });

    it('5.1 marche/[id].tsx renders "Ce post n\'existe plus." and hides the comment input', () => {
        const src = readSource('app/(app)/marche/[id].tsx');
        expect(src).toMatch(/detailError === 'not_found'\s*\?\s*"Ce post n'existe plus\."/);
        expect(src).toMatch(/detailError !== 'not_found' && id \?/);
        expect(src).toMatch(/\{activePost && !detailError \? \(\s*<View style=\{styles\.inputWrap\}>/);
        expect(src).not.toMatch(/\{activePost \? \(\s*<View style=\{styles\.inputWrap\}>/);
    });

    it('5.2 discussions.tsx shows a distinct offline friends empty state', () => {
        const src = readSource('app/(app)/discussions.tsx');
        expect(src).toMatch(/partnersOffline \? \(\s*<EmptyState\s*icon="cloud-offline-outline"/);
        expect(src).toMatch(/title="Vos amis apparaîtront à la reconnexion\."/);
        expect(src).toMatch(/subtitle="Revenez une fois la connexion rétablie\."/);
    });

    it('5.3 messages/[room_id].tsx surfaces a failed load with a retry button', () => {
        const src = readSource('app/(app)/messages/[room_id].tsx');
        expect(src).toMatch(/const \[loadError, setLoadError\] = useState\(false\);/);
        expect(src).toMatch(/const loadMessages = useCallback\(async \(\) => \{/);
        expect(src).toMatch(/catch \{\s*setLoading\(false\);\s*setLoadError\(true\);\s*\}/);
        expect(src).toMatch(/\) : loadError \? \(\s*<View style=\{styles\.empty\}>/);
        expect(src).toMatch(/Impossible de charger la conversation\./);
        expect(src).toMatch(/accessibilityLabel="Réessayer"/);
        expect(src).toMatch(/>Réessayer<\/Text>/);
    });

    it('5.4 ventes/index.tsx labels the credit filter "En dette" (not "À payer")', () => {
        const src = readSource('app/(app)/ventes/index.tsx');
        expect(src).toMatch(/f === 'credit' \? 'En dette' : 'Annulés'/);
        expect(src).not.toMatch(/f === 'credit' \? 'À payer'/);
        expect(src).toMatch(/\$\{c\} en dette/);
    });

    it('5.5 clients/[name].tsx says "Aucun crédit pour le moment." for cash-only clients', () => {
        const src = readSource('app/(app)/clients/[name].tsx');
        expect(src).toMatch(/Aucun crédit pour le moment\./);
        expect(src).not.toMatch(/Aucune vente enregistrée\./);
    });

    it('5.6 depenses/index.tsx renders a "Refusée" tag via statusPill for rejected expenses', () => {
        const src = readSource('app/(app)/depenses/index.tsx');
        expect(src).toMatch(/expense\.status === 'rejete' \? palette\.textSecondary : palette\.warning/);
        expect(src).toMatch(/styles\.statusPill, \{ marginTop: 4, backgroundColor: palette\.danger \+ '20', borderWidth: 1, borderColor: palette\.danger \+ '60' \}\]/);
        expect(src).toMatch(/>Refusée<\/Text>/);
    });

    it('5.7 fournisseurs/[id].tsx tells the truth about delete blockers and cascade erasure', () => {
        const src = readSource('app/(app)/fournisseurs/[id].tsx');
        expect(src).toMatch(/const hasHistory = supplierCommandes\.length > 0;/);
        expect(src).toMatch(/const hasFullyPaidDebt = debts\.some\(/);
        expect(src).toMatch(/'Suppression impossible'/);
        expect(src).toMatch(/a un historique de commandes qui bloque la suppression\./);
        expect(src).toMatch(/son historique de paiements sera effacé\. Cette action est irréversible\./);
    });

    it('5.8 discussions.tsx exposes "Mon code" in the Amis toolbar (reachable with ≥1 partner)', () => {
        const src = readSource('app/(app)/discussions.tsx');
        expect(src).toMatch(/Toolbar: "Mon code" \(always reachable\)/);
        expect(src).toMatch(/onPress=\{\(\) => setShowShareCode\(true\)\}/);
        expect(src).toMatch(/accessibilityLabel="Mon code"/);
        expect(src).toMatch(/<Ionicons name="key-outline" size=\{18\} color=\{palette\.primary\} \/>/);
    });

    it('5.9 app/invite.tsx toasts on invalid/expired token and stores/inviter.ts adds timeouts', () => {
        const invite = readSource('app/invite.tsx');
        expect(invite).toMatch(/import \{ toast \} from '@\/stores\/toast';/);
        expect(invite).toMatch(/toast\.warning\(networkErr \? 'Problème de connexion, réessayez\.' : "Lien d'invitation invalide ou expiré\."\);/);

        const store = readSource('stores/inviter.ts');
        expect(store).toMatch(/await withTimeout\(supabase\.rpc\('record_invite_attempt'\)\);/);
        expect(store).toMatch(/await withTimeout\(supabase\.rpc\('resolve_consumer_invite', \{ p_token: token, p_code: code \}\)\);/);
    });
});
