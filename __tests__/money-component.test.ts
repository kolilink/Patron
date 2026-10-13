// Money is the one thing that must never render wrong. The vendor-visible contract of <Money>/<MoneyText>:
// WHAT TEXT shows (grouped, with currency, never "NaN"), at WHAT SIZE (readable floor, never microscopic),
// on ONE line without an ellipsis — asserted on the pure layer the components are thin wrappers over.
import fs from 'fs';
import path from 'path';
import {
  amountText, childrenToText, estimateTextWidth, fitMoney, moneyBudget, moneyTextProps, toAmount,
  MIN_MONEY_FONT, MIN_MONEY_SCALE, MASK,
} from '@/src/utils/moneyText';
import { typography } from '@/src/theme/typography';
import { computeLocalKpis } from '@/src/utils/salesTotals';

const NB = '\u00A0';
const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const WIDTHS = [320, 360, 390, 430];
const AMOUNTS = [0, 5, 1_000, 1_226_000, 99_999_999, 12_345_678_901, 9_999_999_999_999];

describe('the Accueil debts card — the bug that started this (1 226 000 GNF shown as "1226000GNF", microscopic)', () => {
  const credit = (total: number) => computeLocalKpis({
    cached: null, products: [], variantsByProduct: {}, now: new Date('2026-10-12T12:00:00'),
    sales: [{ id: 's', status: 'credit', total_amount: total, created_at: '2026-10-10T10:00:00Z', customer_name: 'Test', amount_paid: 0 }],
  }).credit_total;

  it('shows the formatted, grouped total with its currency', () => {
    expect(amountText(credit(1_226_000), 'GNF')).toBe(`1${NB}226${NB}000 GNF`);
  });
  it('whatever shape the figure arrives in (number, cached numeric string) it renders the same text — never raw digits', () => {
    expect(amountText('1226000', 'GNF')).toBe(`1${NB}226${NB}000 GNF`);
    expect(amountText(Number('122600000') / 100, 'GNF')).toBe(`1${NB}226${NB}000 GNF`);
  });
  it('is rendered at the design size (32) on every phone width — not shrunk to microscopic', () => {
    for (const w of WIDTHS) {
      const p = moneyTextProps({ text: amountText(1_226_000, 'GNF'), baseFontSize: typography.amountLarge.fontSize, baseLineHeight: typography.amountLarge.lineHeight, windowWidth: w });
      expect(p.fontSize).toBe(32);
      expect(p.fits).toBe(true);
    }
  });
});

describe('text: one formatter, never garbage', () => {
  it('signed / value-only / prefix / suffix / masked', () => {
    expect(amountText(1500, 'GNF', { signed: true })).toBe(`+1${NB}500 GNF`);
    expect(amountText(-500, 'GNF', { signed: true })).toBe('-500 GNF');
    expect(amountText(1500, 'GNF', { valueOnly: true })).toBe(`1${NB}500`);
    expect(amountText(1500, 'GNF', { prefix: 'Reste : ' })).toBe(`Reste : 1${NB}500 GNF`);
    expect(amountText(1500, 'GNF', { masked: true })).toBe(`${MASK} GNF`);
  });
  it('a missing/NaN/garbage amount renders "—", never "NaN GNF" or an unformatted number', () => {
    for (const bad of [NaN, undefined, null, 'abc', {}, Infinity]) expect(amountText(bad, 'GNF')).toBe('—');
    expect(toAmount('12 000')).toBeNaN();
  });
  it('MoneyText children flatten to one string; an element child is a loud bug', () => {
    expect(childrenToText(['Reste : ', amountText(1000, 'GNF'), ' dû'])).toBe(`Reste : 1${NB}000 GNF dû`);
    expect(childrenToText(['x', 3, null, false])).toBe('x3');
    expect(() => childrenToText({ type: 'span' })).toThrow(/must be text/);
  });
});

describe('size: readable, never microscopic, never ellipsized — across phones, variants and magnitudes', () => {
  const variants = ['amountLarge', 'amount', 'amountSmall', 'h1', 'h2', 'h4', 'body', 'label', 'caption'] as const;
  it('every variant × width × amount fits its budget at a readable size', () => {
    const bad: string[] = [];
    for (const v of variants) for (const w of WIDTHS) for (const n of AMOUNTS) {
      const t = typography[v];
      const text = amountText(n, 'GNF');
      const p = moneyTextProps({ text, baseFontSize: t.fontSize, baseLineHeight: t.lineHeight, windowWidth: w });
      const floor = Math.max(MIN_MONEY_FONT, t.fontSize * MIN_MONEY_SCALE);
      if (p.fontSize < floor || p.fontSize > t.fontSize || !p.fits) bad.push(`${v}@${w}:${n}→${p.fontSize}${p.fits ? '' : ' CLIPS'}`);
    }
    expect(bad).toEqual([]);
  });
  it('a normal amount keeps its design size (no needless shrinking); only a huge one shrinks', () => {
    const t = typography.amountLarge;
    expect(moneyTextProps({ text: amountText(250_000, 'GNF'), baseFontSize: t.fontSize, baseLineHeight: t.lineHeight, windowWidth: 360 }).fontSize).toBe(32);
    expect(moneyTextProps({ text: amountText(9_999_999_999_999, 'GNF'), baseFontSize: t.fontSize, baseLineHeight: t.lineHeight, windowWidth: 360 }).fontSize).toBeLessThan(32);
  });
  it('line height shrinks with the font (no clipped glyphs, no huge empty line)', () => {
    const f = fitMoney(amountText(9_999_999_999_999, 'GNF'), 32, 40, moneyBudget(360, 32));
    expect(f.lineHeight).toBe(Math.round(40 * (f.fontSize / 32)));
  });
  it('a caller can pass an explicit width budget (dp) or full/half', () => {
    expect(moneyBudget(360, 14, 100)).toBe(100);
    expect(moneyBudget(360, 14, 'full')).toBeGreaterThan(moneyBudget(360, 14, 'half'));
    expect(moneyBudget(360, 32)).toBe(moneyBudget(360, 14, 'full')); // hero sizes default to the full width
  });
  it('the estimate is conservative: a digit is wider than the text-size/2', () => {
    expect(estimateTextWidth('0000', 10)).toBeGreaterThan(20);
  });
});

describe('structure: the mechanism cannot be bypassed', () => {
  it('Text throws in dev on an unknown variant (no silent fallback to small text)', () => {
    expect(read('src/components/ui/Text.tsx')).toMatch(/if \(__DEV__ && !typography\[variant\]\) throw/);
  });
  it('Money/MoneyText: one line, clipped not ellipsized, native autosize is not used', () => {
    const src = read('src/components/ui/Money.tsx');
    expect(src).toContain('numberOfLines={1}');
    expect(src).toContain('ellipsizeMode="clip"');
    expect(src.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "")).not.toContain("adjustsFontSizeToFit");
  });
  it('every variant used by name in the app exists in the theme (the compile-time check, re-asserted for string literals)', () => {
    const walk = (d: string, out: string[] = []): string[] => { for (const e of fs.readdirSync(path.join(__dirname, '..', d), { withFileTypes: true })) { const r = `${d}/${e.name}`; if (e.isDirectory()) walk(r, out); else if (/\.tsx$/.test(e.name)) out.push(r); } return out; };
    const bad: string[] = [];
    for (const f of ['app', 'src'].flatMap(d => walk(d))) {
      for (const m of read(f).matchAll(/<(?:Text|Money|MoneyText)\b[^>]*?\bvariant="(\w+)"/g)) if (!(m[1] in typography)) bad.push(`${f}:${m[1]}`);
    }
    expect(bad).toEqual([]);
  });
});

describe('every screen that shows money renders it through Money/MoneyText', () => {
  const SCREENS = [
    'app/(app)/(tabs)/index.tsx', 'app/(app)/(tabs)/vendre.tsx', 'app/(app)/apports/index.tsx', 'app/(app)/clients/[name].tsx',
    'app/(app)/clients/index.tsx', 'app/(app)/equipe/index.tsx', 'app/(app)/fournisseurs/[id].tsx', 'app/(app)/fournisseurs/index.tsx',
    'app/(app)/fournisseurs/reception.tsx', 'app/(app)/onboarding/carnet.tsx', 'app/(app)/rapports/index.tsx', 'app/(app)/ventes/index.tsx',
    'src/components/CreditRapideCapture.tsx', 'src/components/FirstRunHeroOverlay.tsx', 'src/components/QuickAddProductSheet.tsx',
    'src/components/QuickCaptureSheet.tsx', 'src/components/expenses/CountUpAmount.tsx', 'src/components/expenses/ExpenseRow.tsx',
    'src/components/expenses/ExpenseSheet.tsx', 'src/components/products/ProductSubSheets.tsx',
  ];
  it.each(SCREENS)('%s', f => {
    const src = read(f);
    expect(src).toMatch(/<Money(Text)?\b/);
    expect(src).toContain("from '@/src/components/ui/Money'");
  });
  it('the Accueil debt card is a Money (the instance)', () => {
    expect(read('app/(app)/(tabs)/index.tsx')).toMatch(/<MoneyText[^>]*variant="amountLarge"[\s\S]{0,200}amtOrMask\(shownKpis\?\.credit_total \?\? 0\)/);
  });
});
