// Phase 5 — the "conseil" line. Alpha may describe sourced patterns and point
// to the existing "Rappeler" (reminder) screen, but it must NEVER guarantee a
// result, advise a loan/tax/investment, use imperative money language, or
// contact a debtor itself. These properties live in STATIC_INSTRUCTIONS, which
// the model receives verbatim every turn — so they are asserted hermetically.

import { STATIC_INSTRUCTIONS } from '../supabase/functions/alpha-chat/lib';

describe('Phase 5 — conseil line (safety responses)', () => {
    it('forbids guarantees of results', () => {
        expect(STATIC_INSTRUCTIONS).toMatch(/garantir/i);
    });

    it('forbids loan / investment / tax / legal advice', () => {
        expect(STATIC_INSTRUCTIONS).toMatch(/emprunt/i);
        expect(STATIC_INSTRUCTIONS).toMatch(/investissement/i);
        expect(STATIC_INSTRUCTIONS).toMatch(/fiscal|juridique/i);
    });

    it('forbids imperative money language ("tu dois", "il faut absolument")', () => {
        expect(STATIC_INSTRUCTIONS).toMatch(/tu dois/i);
        expect(STATIC_INSTRUCTIONS).toMatch(/il faut absolument/i);
    });

    it('absolutely forbids Alpha from contacting a debtor itself', () => {
        expect(STATIC_INSTRUCTIONS).toMatch(/ne contactes JAMAIS/i);
        expect(STATIC_INSTRUCTIONS).toMatch(/client d[ée]biteur/i);
    });

    it('allows describing observed patterns and pointing to the client record', () => {
        expect(STATIC_INSTRUCTIONS).toMatch(/tendances observ[ée]es/i);
        expect(STATIC_INSTRUCTIONS).toMatch(/fiche du client/i);
    });

    it('never claims to modify data, contact anyone, or act', () => {
        expect(STATIC_INSTRUCTIONS).toMatch(/AUCUNE op[ée]ration d'[ée]criture/i);
        expect(STATIC_INSTRUCTIONS).toMatch(/contacter un client|envoyer un message|faire une action/i);
    });
});
