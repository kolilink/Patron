// supabase/functions/alpha-chat/lib.ts — the deterministic "glass wall".
// Pure logic: no Deno, no network. These tests assert the intention→skill
// lookup is a FIXED keyword table (never model-chosen), that the prompt
// builder injects ONLY the skill envelope + system instructions with the
// EXACT formatted figure, and that empty/missing data always yields a
// deterministic "no invented figure" answer.

import {
    IDK_MESSAGE,
    ALPHA_DISCLOSURE,
    ALPHA_LABEL,
    ALPHA_WARNING,
    SKILL_INTENTIONS,
    STATIC_INSTRUCTIONS,
    buildSystemPrompt,
    computeDataHash,
    emptyAnswerFor,
    estimateCost,
    extractPeriod,
    formatMoney,
    isEnvelopeEmpty,
    routeIntent,
} from '../supabase/functions/alpha-chat/lib';

describe('routeIntent — deterministic intention→skill lookup (never model-chosen)', () => {
    it('maps credit/debt questions to creances', () => {
        expect(routeIntent('Qui me doit encore de l\'argent ?').intention).toBe('creances');
        expect(routeIntent('Montre-moi mes crédits en cours').intention).toBe('creances');
        expect(routeIntent('Quelles sont mes dettes impayées ?').intention).toBe('creances');
    });

    it('maps stock questions to stock_bas (current state, not period-bound)', () => {
        const r = routeIntent('Quels produits sont en rupture ?');
        expect(r.intention).toBe('stock_bas');
        expect(r.debut).toBeNull();
        expect(r.fin).toBeNull();
    });

    it('maps product/best-seller questions to top_produits', () => {
        expect(routeIntent('Quels sont mes produits les plus vendus ?').intention).toBe('top_produits');
    });

    it('maps client questions to top_clients', () => {
        expect(routeIntent('Qui est mon meilleur client ?').intention).toBe('top_clients');
    });

    it('maps open-ended revenue questions to ventes_periode (the default skill)', () => {
        expect(routeIntent('Comment vont mes ventes ?').intention).toBe('ventes_periode');
        expect(routeIntent('Bonjour').intention).toBe('ventes_periode');
    });

    it('only ever returns one of the 5 allowed skills', () => {
        const probes = [
            'crédit', 'dette', 'rupture', 'stock bas', 'produit le plus vendu',
            'meilleur client', 'ventes ce mois-ci', 'chiffre d\'affaires', 'bonjour',
            'mes bénéfices', 'mes marges', 'mon profit net',
        ];
        for (const p of probes) {
            expect(SKILL_INTENTIONS).toContain(routeIntent(p).intention);
        }
    });

    it('never routes margin/profit questions to a skill that would expose cost (margins excluded at launch)', () => {
        // "marge" / "bénéfice" / "profit net" must NOT resolve to a cost-bearing
        // skill — at launch none of the 5 skills returns margins, so these fall to
        // the default ventes_periode (revenue only).
        expect(routeIntent('Quelle est ma marge brute ?').intention).toBe('ventes_periode');
        expect(routeIntent('Combien de bénéfice net ?').intention).toBe('ventes_periode');
    });
});

describe('extractPeriod — French period phrases', () => {
    const now = new Date('2026-09-26T12:00:00Z');

    it('parses "du 1er au 26 septembre"', () => {
        const p = extractPeriod('mes ventes du 1er au 26 septembre', now);
        expect(p.debut).toBe('2026-09-01');
        expect(p.fin).toBe('2026-09-26');
        expect(p.label).toContain('1er septembre');
    });

    it('parses "ce mois-ci"', () => {
        const p = extractPeriod('mes ventes ce mois-ci', now);
        expect(p.debut).toBe('2026-09-01');
        expect(p.fin).toBe('2026-09-26');
    });

    it('parses "le mois dernier"', () => {
        const p = extractPeriod('mes ventes le mois dernier', now);
        expect(p.debut).toBe('2026-08-01');
        expect(p.fin).toBe('2026-08-31');
    });

    it('parses "hier" and "aujourd\'hui"', () => {
        expect(extractPeriod('mes ventes hier', now).fin).toBe('2026-09-25');
        expect(extractPeriod("mes ventes aujourd'hui", now).debut).toBe('2026-09-26');
    });

    it('parses "les 7 derniers jours"', () => {
        const p = extractPeriod('les 7 derniers jours', now);
        expect(p.debut).toBe('2026-09-20');
        expect(p.fin).toBe('2026-09-26');
    });

    it('parses "depuis le début" as an unbounded-lower period', () => {
        const p = extractPeriod('mes ventes depuis le début', now);
        expect(p.debut).toBe('1970-01-01');
        expect(p.fin).toBe('2026-09-26');
    });

    it('defaults to the last 30 days when no period is given', () => {
        const p = extractPeriod('comment vont mes ventes', now);
        expect(p.debut).toBe('2026-08-28');
        expect(p.fin).toBe('2026-09-26');
    });
});

describe('formatMoney — BIGINT cents → display string (model never sees raw cents)', () => {
    it('formats GNF (zero-decimal) with thousands separators and no decimals', () => {
        expect(formatMoney(1_234_500, 'GNF')).toBe('12 345 GNF');
    });

    it('formats USD with two decimals', () => {
        expect(formatMoney(123_456, 'USD')).toBe('1 234,56 USD');
    });

    it('formats XOF (zero-decimal) without decimals', () => {
        expect(formatMoney(500_000, 'XOF')).toBe('5 000 XOF');
    });

    it('treats null/NaN cents as zero', () => {
        expect(formatMoney(Number.NaN, 'GNF')).toBe('0 GNF');
    });
});

describe('buildSystemPrompt — injects ONLY the envelope + system instructions, EXACT figure', () => {
    const envelope = {
        intention: 'ventes_periode',
        autorise: true,
        valeur: 1_234_500, // 12 345 GNF in cents
        nombre_ventes: 42,
        periode: { debut: '2026-09-01', fin: '2026-09-26' },
        provenance: "d'après tes ventes enregistrées",
        chemin_details: { ecran: 'ventes', filtre: 'periode' },
        version_donnees: 7,
    };

    const prompt = buildSystemPrompt({
        businessName: 'Chez Awa',
        businessType: 'boutique',
        currency: 'GNF',
        role: 'administrateur',
        envelope,
    });

    it('contains the EXACT formatted figure (not raw cents, not a rounded variant)', () => {
        expect(prompt).toContain('12 345 GNF');
        expect(prompt).not.toContain('1234500');
    });

    it('contains the exact period phrase', () => {
        expect(prompt).toContain('du 1er septembre au 26 septembre');
    });

    it('contains the provenance phrase and detail path', () => {
        expect(prompt).toContain("d'après tes ventes enregistrées");
        expect(prompt).toContain('"ecran":"ventes"');
    });

    it('does NOT embed raw table rows or any other business id', () => {
        expect(prompt).not.toContain('business_id');
        expect(prompt).not.toContain('sale_orders');
    });

    it('uses the "tu" voice and forbids "vous"', () => {
        expect(STATIC_INSTRUCTIONS).toContain('tu');
        expect(STATIC_INSTRUCTIONS).not.toMatch(/Vouvoie/);
    });
});

describe('isEnvelopeEmpty / emptyAnswerFor — missing data never invents a figure', () => {
    it('treats autorise=false as empty', () => {
        expect(isEnvelopeEmpty({ intention: 'ventes_periode', autorise: false, valeur: 100 })).toBe(true);
    });

    it('treats an empty array as empty', () => {
        expect(isEnvelopeEmpty({ intention: 'creances', autorise: true, valeur: [] })).toBe(true);
    });

    it('treats null value as empty', () => {
        expect(isEnvelopeEmpty({ intention: 'stock_bas', autorise: true, valeur: null })).toBe(true);
    });

    it('treats a numeric value as non-empty', () => {
        expect(isEnvelopeEmpty({ intention: 'ventes_periode', autorise: true, valeur: 0 })).toBe(false);
    });

    it('returns a deterministic, figure-free answer for every skill', () => {
        for (const s of SKILL_INTENTIONS) {
            const a = emptyAnswerFor(s);
            expect(a).toBeTruthy();
            expect(a).not.toMatch(/\d/); // no invented number
        }
    });

    it('exposes the exact IDK message and transparency strings', () => {
        expect(IDK_MESSAGE).toBe("Je n'ai pas cette information.");
        expect(ALPHA_LABEL).toBe("Alpha, l'assistant IA");
        expect(ALPHA_DISCLOSURE).toContain('assistant automatique de Patron');
        expect(ALPHA_WARNING).toContain('vérifie avec tes chiffres');
    });
});

describe('computeDataHash — deterministic audit fingerprint', () => {
    it('is deterministic and sensitive to data changes', () => {
        const a = { intention: 'ventes_periode', valeur: 100 };
        const b = { intention: 'ventes_periode', valeur: 200 };
        expect(computeDataHash(a)).toBe(computeDataHash(a));
        expect(computeDataHash(a)).not.toBe(computeDataHash(b));
    });
});

describe('estimateCost — Phase 6 cost capture', () => {
    it('returns 0 for unknown models and positive cost for known ones', () => {
        expect(estimateCost('unknown-model', 1000, 1000)).toBe(0);
        expect(estimateCost('gpt-4o-mini', 1000, 1000)).toBeGreaterThan(0);
        expect(estimateCost('openai/gpt-oss-20b', 1000, 1000)).toBeGreaterThanOrEqual(0);
    });
});
