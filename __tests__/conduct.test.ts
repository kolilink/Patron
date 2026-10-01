// Phase 2 + Phase 4 + Phase 5, item 7 — the social-spaces text contract.
// These constants are the literal strings shown to members, so any change
// must be deliberate (CONDUCT_VERSION gate). This hermetic test pins them:
// exactly 5 conduct rules, exactly 4 privacy-wall interdictions, exactly 5
// report motifs, and the server-authored French sentences that must reach
// the user verbatim (never rewritten by the English translation table).
import {
    CONDUCT_VERSION,
    CONDUCT_RULES,
    PRIVACY_PROMISE,
    PRIVACY_INTERDICTIONS,
    REPORT_MOTIFS,
} from '@/src/constants/conduct';
import { friendlyMessage, extractRawMessage, translateError } from '@/lib/errors';

describe('code de conduite (Phase 2)', () => {
    it('is versioned and has exactly the five required rules', () => {
        expect(CONDUCT_VERSION).toBe(1);
        expect(CONDUCT_RULES).toHaveLength(5);
    });

    it('declares the five mandated rule ids in order', () => {
        expect(CONDUCT_RULES.map(r => r.id)).toEqual([
            'harcelement',
            'donnees_privees',
            'spam',
            'mauvais_espace',
            'moderation',
        ]);
    });

    it('gives every rule a non-empty short label and full text', () => {
        for (const rule of CONDUCT_RULES) {
            expect(rule.short.trim().length).toBeGreaterThan(0);
            expect(rule.full.trim().length).toBeGreaterThan(0);
        }
    });

    it('forbids private/money data and spam in plain French', () => {
        const privacy = CONDUCT_RULES.find(r => r.id === 'donnees_privees')!;
        const spam = CONDUCT_RULES.find(r => r.id === 'spam')!;
        expect(privacy.full).toContain('Jamais de dettes');
        expect(privacy.full).toContain('données privées');
        expect(spam.full).toContain('Pas de spam');
    });
});

describe('mur de confidentialité (Phase 4)', () => {
    it('states the promise that money never leaves the carnet', () => {
        expect(PRIVACY_PROMISE).toBe('Vos chiffres ne quittent jamais votre carnet.');
    });

    it('has exactly the four absolute interdictions', () => {
        expect(PRIVACY_INTERDICTIONS).toHaveLength(4);
        expect(PRIVACY_INTERDICTIONS.map(i => i.id)).toEqual([
            'autocomplete',
            'recherche',
            'partage',
            'alpha',
        ]);
    });

    it('never exposes a publish/share affordance from financial screens', () => {
        const partage = PRIVACY_INTERDICTIONS.find(i => i.id === 'partage')!;
        expect(partage.title).toContain('Partager');
        expect(partage.full).toContain('ne proposent jamais');
    });
});

describe('motifs de signalement (Phase 1)', () => {
    it('offers exactly the five expected motifs', () => {
        expect(REPORT_MOTIFS).toHaveLength(5);
        expect(REPORT_MOTIFS.map(m => m.id)).toEqual([
            'harcelement',
            'donnees_privees',
            'spam',
            'mauvais_espace',
            'autre',
        ]);
    });

    it('gives every motif a non-empty label and icon', () => {
        for (const motif of REPORT_MOTIFS) {
            expect(motif.label.trim().length).toBeGreaterThan(0);
            expect(motif.icon.trim().length).toBeGreaterThan(0);
        }
    });
});

describe('friendlyMessage — server-authored French passthrough', () => {
    it('preserves the non-punitive rate-limit sentence verbatim', () => {
        const err = new Error('Doucement — vous pourrez republier dans 42 minutes.');
        expect(friendlyMessage(err, 'fallback'))
            .toBe('Doucement — vous pourrez republier dans 42 minutes.');
    });

    it('preserves the invalid-category sentence (with and without accents)', () => {
        expect(friendlyMessage(new Error('Catégorie invalide'), 'fallback'))
            .toBe('Catégorie invalide');
        expect(friendlyMessage(new Error('Categorie invalide'), 'fallback'))
            .toBe('Categorie invalide');
    });

    it('preserves the identity, report and moderation sentences verbatim', () => {
        const sentences = [
            'Votre pseudo est requis pour publier.',
            'Vous ne pouvez pas signaler votre propre post',
            'Vous avez déjà signalé ce post',
            'Post introuvable',
            'Motif invalide',
            'Accès refusé',
            'Le pseudo doit contenir entre 2 et 30 caractères',
        ];
        for (const s of sentences) {
            expect(friendlyMessage(new Error(s), 'fallback')).toBe(s);
        }
    });

    it('still translates unknown English errors rather than passing them through', () => {
        expect(friendlyMessage(new Error('permission denied for table'), 'fallback'))
            .toBe('Accès refusé');
        expect(friendlyMessage(new Error('invalid login credentials'), 'fallback'))
            .toBe('Email ou mot de passe incorrect');
    });

    it('falls back for non-Error values', () => {
        expect(friendlyMessage(null, 'Erreur inattendue')).toBe('Erreur inattendue');
        expect(friendlyMessage(undefined, 'Erreur inattendue')).toBe('Erreur inattendue');
        expect(friendlyMessage({ code: 42 }, 'Erreur inattendue')).toBe('Erreur inattendue');
    });
});

describe('extractRawMessage', () => {
    it('reads message from Error and plain objects with a string message', () => {
        expect(extractRawMessage(new Error('boom'))).toBe('boom');
        expect(extractRawMessage({ message: 'plain' })).toBe('plain');
    });

    it('returns null for values without a string message', () => {
        expect(extractRawMessage('just a string')).toBeNull();
        expect(extractRawMessage(null)).toBeNull();
        expect(extractRawMessage({ message: 42 })).toBeNull();
    });
});

describe('translateError sanity (unchanged behaviour)', () => {
    it('translates a known pattern and falls back otherwise', () => {
        expect(translateError(new Error('duplicate key'), 'fallback')).toBe('Cette entrée existe déjà');
        expect(translateError(new Error('totally unknown'), 'Inconnu')).toBe('Inconnu');
    });
});
