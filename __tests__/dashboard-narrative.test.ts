// Accueil speaks only on genuine gains (src/utils/dashboardNarrative.ts) and the
// screen is wired to it. The SQL side (revenue_last_month) is proven in
// __tests__/integration/dashboard-revenue-last-month.integration.test.ts.
import fs from 'fs';
import path from 'path';
import { homeComparison, showMonthLine } from '@/src/utils/dashboardNarrative';

const base = { hasEverSold: true, isFirstSaleToday: false, isEvening: false, delta: 0, monthRevenue: 0, lastMonthRevenue: 0 };

describe('day comparison under "Aujourd\'hui"', () => {
  it('delta > 0 → the gain pill', () => expect(homeComparison({ ...base, delta: 5 }).kind).toBe('pill'));
  it('delta == 0 → nothing ("Même niveau qu\'hier" is gone)', () => expect(homeComparison({ ...base, delta: 0 }).kind).toBe('none'));
  it('delta < 0 → nothing', () => expect(homeComparison({ ...base, delta: -5 }).kind).toBe('none'));
  it('"Bienvenue" and "Première vente enregistrée ✓" are untouched, whatever the delta', () => {
    expect(homeComparison({ ...base, hasEverSold: false, delta: -9 }).kind).toBe('welcome');
    expect(homeComparison({ ...base, isFirstSaleToday: true, delta: 0 }).kind).toBe('first_sale');
  });
});

describe('the "Ce mois" line', () => {
  it('shows ONLY when this month is strictly greater than last month', () => {
    expect(showMonthLine(101, 100)).toBe(true);
    expect(showMonthLine(100, 100)).toBe(false);   // equal → silent
    expect(showMonthLine(20, 5000)).toBe(false);   // "Ce mois : 20 GNF" never says itself
    expect(showMonthLine(0, 0)).toBe(false);       // never a zero
  });
  it('evening/night comparison: month line only on a gain, otherwise nothing', () => {
    expect(homeComparison({ ...base, isEvening: true, monthRevenue: 500, lastMonthRevenue: 100 }).kind).toBe('month');
    expect(homeComparison({ ...base, isEvening: true, monthRevenue: 100, lastMonthRevenue: 500 }).kind).toBe('none');
    expect(homeComparison({ ...base, isEvening: true, monthRevenue: 100, lastMonthRevenue: 100 }).kind).toBe('none');
  });
  it('a missing last-month figure (older cache/server) reads as 0, so revenue > 0 still shows', () => {
    expect(showMonthLine(300, 0)).toBe(true);
  });
});

describe('screen wiring', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../app/(app)/(tabs)/index.tsx'), 'utf8');
  it('reads revenue_last_month and gates BOTH month spots on showMonthLine', () => {
    expect(src).toMatch(/revenue_last_month: Number\(d\.revenue_last_month \?\? 0\) \/ 100/);
    expect(src).toMatch(/const lastMonthRevenue = kpis\?\.revenue_last_month \?\? 0;/);
    expect(src).toMatch(/const showMonthLine = monthRevenue > lastMonthRevenue;/);
    expect(src).toMatch(/dayPart !== 'evening' && dayPart !== 'night' && showMonthLine/);
    expect(src).toMatch(/comparison\.kind === 'month' \? `Ce mois : \$\{amtOrMask\(monthRevenue\)\}`/);   // privacy mask kept
  });
  it('the old gates and the flat-day sentence are gone; the investor block is untouched', () => {
    expect(src).not.toMatch(/hasMonthRevenue/);
    expect(src).not.toMatch(/hideComparison/);
    // no executable string (comments may still explain the history)
    expect(src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')).not.toMatch(/Même niveau qu'hier/);
    expect(src).toMatch(/`Ce mois · \$\{monthOrderCount\} vente/);
  });
});
