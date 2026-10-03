// "Retire tout moyen de contact des espaces publics" — automated audit.
//
// The three public spaces (Amis / Mon commerce / Le Marché) must expose zero
// contact surface: no wa.me link, no tel: link, no WhatsApp deep-link, no
// Linking.openURL/Share.share action, and no phone number rendered anywhere.
// The "Mon commerce" card must be strictly read-only (name, activity, logo)
// with no interactive contact element.
//
// This is a source-level audit: it reads the public-space components as plain
// text and asserts the forbidden patterns are absent. It is hermetic (no
// native modules, no Supabase), so it runs in the default fast `npm test`.
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');

// Every component that renders inside one of the three public spaces.
const PUBLIC_SPACE_FILES = [
    // Amis / Mon commerce / Le Marché — single screen with all three tabs.
    'app/(app)/discussions.tsx',
    // Le Marché post detail.
    'app/(app)/marche/[id].tsx',
    // Shared Le Marché UI.
    'src/components/ui/PostActionsMenu.tsx',
    'src/components/ui/ConductBanner.tsx',
    'src/components/ui/PrivacyWallSheet.tsx',
    'src/components/ui/PseudoSheet.tsx',
];

function readSource(rel: string): string {
    return readFileSync(join(ROOT, rel), 'utf8');
}

const sources = PUBLIC_SPACE_FILES.map(rel => ({ rel, text: readSource(rel) }));

// Phone numbers in the formats the app would ever render: a separated form
// (00 000 00 00, +221 77 123 45 67, 221-77-123-45-67, …) or a contiguous run
// of 9+ digits with an optional leading '+'. Deliberately tight so it never
// trips on `fontSize: 32`, `spacing[7]`, dates like 2026-09-22, etc.
const SEPARATED_PHONE = /(?:\+?[0-9]{1,3}[\s.-])?[0-9]{3}[\s.-][0-9]{3}[\s.-][0-9]{4}/;
const CONTIGUOUS_PHONE = /\+?[0-9]{9,}/;

describe('espaces publics — aucun moyen de contact', () => {
    for (const { rel, text } of sources) {
        it(`${rel} — zéro lien wa.me`, () => {
            expect(text).not.toMatch(/wa\.me/i);
        });
        it(`${rel} — zéro lien tel:`, () => {
            expect(text).not.toMatch(/tel:/i);
        });
        it(`${rel} — zéro lien/schéma WhatsApp`, () => {
            // Actual contact surfaces only — the word "WhatsApp" in a code
            // comment (e.g. "same place WhatsApp puts its timestamp") is not a
            // contact action and must not fail the audit.
            expect(text).not.toMatch(/(whatsapp:\/\/|wa\.me|api\.whatsapp\.com|logo-whatsapp)/i);
        });
        it(`${rel} — zéro ouverture d'URL ou partage de message`, () => {
            expect(text).not.toMatch(/Linking\.openURL/);
            expect(text).not.toMatch(/Share\.share/);
            expect(text).not.toMatch(/\bopenURL\b/);
        });
        it(`${rel} — zéro numéro de téléphone rendu ou présent`, () => {
            expect(text).not.toMatch(SEPARATED_PHONE);
            expect(text).not.toMatch(CONTIGUOUS_PHONE);
        });
    }
});

describe('carte "Mon commerce" — supprimée', () => {
    it('la carte identité du commerce (avatar + nom) n\'existe plus dans l\'onglet Ma Boutique', () => {
        const src = readSource('app/(app)/discussions.tsx');
        // The business identity card (avatar + name + activity + logo) was
        // removed entirely from the Ma Boutique tab: the tab now shows only the
        // message input, with no name, no avatar, no card. Every trace of the
        // card (its style keys and its logo/type data bindings) must be gone.
        expect(src).not.toMatch(/commerceCard/);
        expect(src).not.toMatch(/commerceAvatar/);
        expect(src).not.toMatch(/commerceLogo/);
        expect(src).not.toMatch(/businessLogo/);
        expect(src).not.toMatch(/businessType/);
    });
});
