// What catalogue.tsx's "Total investi" and "Bénéfice par pièce" lines print,
// built from the same pure functions the screen calls.

import { perUnitCost, totalInvested, unitProfit } from '@/src/utils/productPricing';
import { formatAmount as realFormatAmount } from '@/src/utils/format';

// Grouping uses U+00A0; normalize so expected strings stay readable.
const formatAmount = (n: number, c: string) => realFormatAmount(n, c).split('\u00A0').join(' ');

const investedLine = (qty: number, pp: number, fees: number, cur = 'GNF') =>
  `Total investi : ${formatAmount(totalInvested(qty, pp, fees), cur)}`;
const profitLine = (sp: number, pp: number, fees: number, qty: number, cur = 'GNF') =>
  `Bénéfice : ${formatAmount(unitProfit(sp, perUnitCost(pp, fees, qty)), cur)} par pièce`;

describe('Bénéfice par pièce', () => {
  it('reported case: a 333.333 GNF unit profit prints "333 GNF", not "333,333 GNF"', () => {
    // sale 1 000, 3 units, 1 000 of fees on a free purchase price: cost 333.33, profit 666.67
    expect(unitProfit(1000, perUnitCost(0, 1000, 3))).toBeCloseTo(666.667, 3);
    expect(profitLine(1000, 0, 1000, 3)).toBe('Bénéfice : 667 GNF par pièce');
    expect(formatAmount(1000 / 3, 'GNF')).toBe('333 GNF');
  });
  it('1 000 000 of fees over 3 units: per-unit cost 333 333 GNF, shown rounded', () => {
    const cost = perUnitCost(0, 1_000_000, 3);
    expect(formatAmount(cost, 'GNF')).toBe('333 333 GNF');
    expect(profitLine(500_000, 0, 1_000_000, 3)).toBe('Bénéfice : 166 667 GNF par pièce');
  });
  it('a loss is a plain negative figure', () => {
    expect(profitLine(100, 300, 0, 1)).toBe('Bénéfice : -200 GNF par pièce');
  });
  it('USD keeps cents', () => {
    expect(profitLine(10, 3, 1, 3, 'USD')).toBe('Bénéfice : 6.67 USD par pièce');
  });
});

describe('Total investi traces to recorded amounts', () => {
  it('= qty × price typed + fees typed', () => {
    expect(investedLine(3, 250_000, 90_000)).toBe('Total investi : 840 000 GNF');
  });
  it('never recomputed as qty × a rounded per-unit figure', () => {
    // 3 units, fees 1 000, free price. Recorded total is 1 000.
    expect(totalInvested(3, 0, 1000)).toBe(1000);
    const roundedPerUnit = Math.round(perUnitCost(0, 1000, 3)); // 333
    expect(3 * roundedPerUnit).toBe(999);                       // the drift this rule forbids
    expect(investedLine(3, 0, 1000)).toBe('Total investi : 1 000 GNF');
  });
  it('a per-unit cost is derived from the total, and total ÷ qty × qty is not the source', () => {
    const total = totalInvested(7, 0, 1_000_000);
    expect(total).toBe(1_000_000);
    expect(formatAmount(perUnitCost(0, 1_000_000, 7), 'GNF')).toBe('142 857 GNF');
  });
});
