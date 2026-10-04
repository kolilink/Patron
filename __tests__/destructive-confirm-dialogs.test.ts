// SWEEP FIX — Phase 2: destructive actions must confirm before acting.
// TEST DB only — do not commit.
//
// Pins, at source level (the same hermetic approach as
// espaces-publics-no-contact.test.ts — no native modules, runs in `npm test`),
// that the destructive post/moderation actions no longer fire immediately but
// go through a native Alert.alert confirmation with a `destructive` confirm
// button. Covers:
//   * PostActionsMenu "Supprimer ce post" (own post)
//   * PostActionsMenu "Bloquer l'auteur" (other's post)
//   * Moderation screen "Supprimer le post" + "Bloquer l'auteur"
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');

function readSource(rel: string): string {
    return readFileSync(join(ROOT, rel), 'utf8');
}

describe('Phase 2 — destructive confirm dialogs (PostActionsMenu + Modération)', () => {
    it('PostActionsMenu delete/block go through Alert.alert with a destructive confirm', () => {
        const src = readSource('src/components/ui/PostActionsMenu.tsx');

        // Both destructive handlers must call Alert.alert (the confirm gate).
        expect(src).toMatch(/import\s*\{[^}]*\bAlert\b[^}]*\}\s*from\s*'react-native'/);

        // Two confirm dialogs (delete + block), each with a destructive
        // confirm action and a cancel.
        const alerts = src.match(/Alert\.alert\(/g) ?? [];
        expect(alerts.length).toBe(2);
        expect(src).toMatch(/text:\s*'Supprimer',\s*style:\s*'destructive'/);
        expect(src).toMatch(/text:\s*'Bloquer',\s*style:\s*'destructive'/);
        expect(src).toMatch(/text:\s*'Annuler',\s*style:\s*'cancel'/);

        // The actual RPC calls must live INSIDE the confirm onPress, not fire
        // immediately at handler top level. Verify the onPress bodies reference
        // the store actions.
        expect(src).toMatch(/onPress:\s*async\s*\(\)\s*=>\s*\{[\s\S]*?deletePost\(post\.id\)/);
        expect(src).toMatch(/onPress:\s*async\s*\(\)\s*=>\s*\{[\s\S]*?blockUser\(post\.author_id\)/);
    });

    it('Modération screen delete/block go through Alert.alert with a destructive confirm + toast', () => {
        const src = readSource('app/(app)/moderation/index.tsx');

        expect(src).toMatch(/import\s*\{[^}]*\bAlert\b[^}]*\}\s*from\s*'react-native'/);

        // Two confirm dialogs (delete post + block author).
        const alerts = src.match(/Alert\.alert\(/g) ?? [];
        expect(alerts.length).toBe(2);
        expect(src).toMatch(/text:\s*'Supprimer',\s*style:\s*'destructive'/);
        expect(src).toMatch(/text:\s*'Bloquer',\s*style:\s*'destructive'/);

        // Success feedback after a confirmed destructive action.
        expect(src).toMatch(/toast\.success\('Post supprimé\.'\)/);
        expect(src).toMatch(/toast\.success\('Auteur bloqué\.'\)/);
        expect(src).toMatch(/from\s*'@\/stores\/toast'/);
    });
});
