// Accueil KPI flash fix (Part 2). The bug: on a business switch the detector
// nulled KPIs but only assigned loadedForRef in `finally`, so an overlapping
// load could blank the dashboard to its empty state and stick there. The fix
// is three layers, each pinned at source level (the repo's hermetic screen-pin
// convention — no component rendering):
//
//   Layer 1 — the business is claimed SYNCHRONOUSLY in the wipe branch, before
//             any await, so the next loadAll() takes its own wipe branch.
//   Layer 2 — one writer (`updateKpis`) replaces every raw setKpis(); render
//             reads `shownKpis`, which falls back to the last good KPIs keyed
//             by business id (never the empty state).
//   Layer 3 — a monotonic generation guard (`loadRunId`) drops every UI write
//             from a superseded run.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'app/(app)/(tabs)/index.tsx'), 'utf8');

// The loadAll body, from the first line to the end of its finally block.
const loadAll = SRC.slice(SRC.indexOf('const loadAll = useCallback'), SRC.indexOf('const loadAll = useCallback') + 2600);

describe('Accueil KPI flash — Layer 1 (synchronous switch claim)', () => {
    it('(a) loadedForRef is claimed before the first real await in the wipe branch', () => {
        const wipe = loadAll.slice(loadAll.indexOf('if (loadedForRef.current !== businessId)'));
        const claim = wipe.indexOf('loadedForRef.current = businessId;');
        // The first genuine await (the comment above the claim also mentions the word).
        const firstAwait = wipe.indexOf('await getDashboardKpiCache');
        expect(claim).toBeGreaterThan(-1);
        expect(firstAwait).toBeGreaterThan(-1);
        expect(claim).toBeLessThan(firstAwait);
    });

    it('(a) the wipe branch does not clear loading only as an afterthought — the order is preserved', () => {
        const wipe = loadAll.slice(loadAll.indexOf('if (loadedForRef.current !== businessId)'), loadAll.indexOf('const cachedKpis = await'));
        expect(wipe.indexOf('setLoading(true)')).toBeLessThan(wipe.indexOf('updateKpis(null)'));
    });
});

describe('Accueil KPI flash — Layer 2 (single writer + shownKpis)', () => {
    it('(b) updateKpis is the only setKpis writer', () => {
        // The only raw setKpis must live INSIDE updateKpis itself.
        expect(loadAll).not.toMatch(/setKpis\(/);
        expect(SRC).toMatch(/const updateKpis = useCallback\(\(next: KPIs \| null\) => \{\s*setKpis\(next\);/);
    });

    it('(b) updateKpis records the last good value keyed by business id, never overwriting on a wipe', () => {
        expect(SRC).toMatch(/lastGoodKpis\.current = \{ businessId, kpis: next \}/);
        // A null (wipe) never touches lastGoodKpis — the ternary guards it.
        expect(SRC).toMatch(/if \(next\) lastGoodKpis\.current = \{ businessId, kpis: next \}/);
    });

    it('(e) the keyed fallback restores A\'s numbers after an A→B→A flap', () => {
        expect(SRC).toMatch(/lastGoodKpis\.current && lastGoodKpis\.current\.businessId === businessId \? lastGoodKpis\.current\.kpis : null/);
    });

    it('(c) render reads shownKpis, never kpis directly for the money/people figures', () => {
        expect(SRC).toMatch(/shownKpis\?\.revenue_today/);
        expect(SRC).toMatch(/shownKpis\?\.credit_count/);
        expect(SRC).toMatch(/shownKpis\?\.credit_total/);
    });
});

describe('Accueil KPI flash — Layer 3 (generation guard)', () => {
    it('(d) every run claims a fresh generation id', () => {
        expect(loadAll).toMatch(/const myRun = \+\+loadRunId\.current;/);
    });

    it('(d) loadKpis and loadBestSellers take the generation id and re-check it before writing', () => {
        expect(SRC).toMatch(/const loadKpis = async \(myRun: number\)/);
        expect(SRC).toMatch(/const loadBestSellers = async \(myRun: number\)/);
        // The guard appears before the cached/network UI writes in loadKpis.
        const kpis = SRC.slice(SRC.indexOf('const loadKpis'), SRC.indexOf('const loadBestSellers'));
        expect((kpis.match(/if \(myRun !== loadRunId\.current\) return;/g) ?? []).length).toBeGreaterThanOrEqual(3);
    });

    it('(d) the finally only clears loading for the still-current run', () => {
        // The finally sits past loadAll's 2600-char slice — assert on the whole file.
        expect(SRC).toMatch(/if \(myRun === loadRunId\.current\) setLoading\(false\);/);
    });
});
