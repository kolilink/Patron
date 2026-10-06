// The money choke point (src/utils/format.ts): ISO 4217 minor units, one
// deterministic round-half-up, no invented precision for any currency.

import {
  formatAmount as realFormatAmount, formatAmountValue as realFormatAmountValue,
  formatSignedAmount as realFormatSignedAmount, formatMargin, formatCount as realFormatCount,
  minorUnits, roundHalfUp, formatAmountInput, parseAmountInput, amountInputToCents,
} from '@/src/utils/format';

// Thousands are grouped with U+00A0 (never wraps mid-number); the space before
// the currency code is a plain one. Tests normalize NBSP so literals stay readable.
const NBSP = '\u00A0';
const flat = (s: string) => s.split(NBSP).join(' ');
const formatAmount = (n: number, c: string) => flat(realFormatAmount(n, c));
const formatAmountValue = (n: number, c: string) => flat(realFormatAmountValue(n, c));
const formatSignedAmount = (n: number, c: string) => flat(realFormatSignedAmount(n, c));
const formatCount = (n: number) => flat(realFormatCount(n));

const ZERO_DECIMAL = ['GNF', 'XOF', 'XAF', 'JPY', 'KRW', 'VND', 'BIF', 'RWF'];
const TWO_DECIMAL = ['USD', 'EUR', 'GBP', 'MAD', 'CAD'];

// Deterministic pseudo-random inputs (no flaky property tests).
function* inputs() {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const fixed = [0, -0, 0.4, 0.5, 0.49999, 1.005, 2.5, -2.5, 333.333, 333333.33, 999999.5, -0.001, 1e9, -1e9, 1e15 + 0.5, 1e21, 1e22, 123456789.987654321];
  for (const f of fixed) yield f;
  for (let i = 0; i < 400; i++) {
    const mag = 10 ** Math.floor(rnd() * 14);
    yield (rnd() - 0.5) * 2 * mag;
  }
}

describe('fixture (the reported bug)', () => {
  it('1 000 ÷ 3 prints "333 GNF" — the value that rendered as "333,333 GNF" (fr-FR 333,333 = 333.333)', () => {
    expect(formatAmount(1000 / 3, 'GNF')).toBe('333 GNF');
  });
  it('1 000 000 ÷ 3 prints "333 333 GNF", never a fractional figure', () => {
    expect(formatAmount(1_000_000 / 3, 'GNF')).toBe('333 333 GNF');
  });
});

describe('separators', () => {
  it('groups thousands with a no-break space and separates the currency with a plain space', () => {
    expect(realFormatAmount(1234567, 'GNF')).toBe('1\u00A0234\u00A0567 GNF');
  });
});

describe('zero-decimal currencies never show a decimal separator', () => {
  for (const cur of ZERO_DECIMAL) {
    it(`${cur}: fractional, negative and huge inputs`, () => {
      for (const n of inputs()) {
        const out = formatAmount(n, cur);
        expect(out).toMatch(/^-?\d{1,3}( \d{3})* [A-Z]{3}$/);
        expect(out).not.toMatch(/[.,]/);
        expect(out).not.toMatch(/e\+|NaN|Infinity/);
      }
    });
  }
  it('non-finite input is shown as 0, never NaN/Infinity', () => {
    expect(formatAmount(NaN, 'GNF')).toBe('0 GNF');
    expect(formatAmount(Infinity, 'GNF')).toBe('0 GNF');
  });
});

describe('two-decimal currencies', () => {
  for (const cur of TWO_DECIMAL) {
    it(`${cur}: at most 2 decimals, and always exactly 2 when there is a fraction`, () => {
      for (const n of inputs()) {
        const out = formatAmount(n, cur);
        expect(out).toMatch(/^-?\d{1,3}( \d{3})*(\.\d{2})? [A-Z]{3}$/);
      }
    });
  }
  it('shows 2 decimals for a real fraction and trims a whole ".00"', () => {
    expect(formatAmount(1234.5, 'USD')).toBe('1 234.50 USD');
    expect(formatAmount(1234, 'USD')).toBe('1 234 USD');
    expect(formatAmount(0.1 + 0.2, 'EUR')).toBe('0.30 EUR');
  });
  it('a tiny negative remainder never prints "-0.00"', () => {
    expect(formatAmount(-0.001, 'USD')).toBe('0 USD');
    expect(formatAmount(-0.004, 'EUR')).toBe('0 EUR');
  });
});

describe('ISO 4217 table', () => {
  it('minor units are table-driven', () => {
    expect(['GNF', 'XOF', 'XAF', 'JPY', 'KRW'].map(minorUnits)).toEqual([0, 0, 0, 0, 0]);
    expect(['USD', 'EUR'].map(minorUnits)).toEqual([2, 2]);
    expect(['KWD', 'TND'].map(minorUnits)).toEqual([3, 3]);
    expect(minorUnits('clf')).toBe(4);
    expect(minorUnits('ZZZ')).toBe(2); // unknown → ISO default, add a row rather than special-case
  });
  it('a 3-decimal currency shows its real third decimal', () => {
    expect(formatAmount(1.2345, 'KWD')).toBe('1.235 KWD');
    expect(formatAmount(2, 'KWD')).toBe('2 KWD');
  });
});

describe('deterministic round-half-up', () => {
  it('2.5 → 3 at 0 decimals (Math.round would also, but -2.5 must mirror it)', () => {
    expect(formatAmount(2.5, 'GNF')).toBe('3 GNF');
    expect(formatAmount(-2.5, 'GNF')).toBe('-3 GNF');
    expect(formatAmount(0.5, 'GNF')).toBe('1 GNF');
    expect(formatAmount(1.5, 'GNF')).toBe('2 GNF');
  });
  it('is decimal-exact, not binary: 1.005 → 1.01 at 2 places', () => {
    expect(roundHalfUp(1.005, 2)).toBe(1.01);
    expect(formatAmount(1.005, 'USD')).toBe('1.01 USD');
    expect(formatAmount(8.345, 'EUR')).toBe('8.35 EUR');
  });
  it('never returns -0', () => {
    expect(Object.is(roundHalfUp(-0.4, 0), 0)).toBe(true);
  });
  it('rounds before grouping: 999 999.5 → 1 000 000', () => {
    expect(formatAmount(999999.5, 'GNF')).toBe('1 000 000 GNF');
  });
});

describe('related formatters share the same rules', () => {
  it('formatAmountValue has no currency suffix', () => {
    expect(formatAmountValue(1234567.8, 'GNF')).toBe('1 234 568');
  });
  it('formatSignedAmount: + only for a gain', () => {
    expect(formatSignedAmount(500, 'GNF')).toBe('+500 GNF');
    expect(formatSignedAmount(-500, 'GNF')).toBe('-500 GNF');
    expect(formatSignedAmount(0.2, 'GNF')).toBe('0 GNF');
  });
  it('formatMargin rounds half-up and never prints -0%', () => {
    expect(formatMargin(1, 8)).toBe('+13%'); // 12.5
    expect(formatMargin(-1, 300)).toBe('0%');
    expect(formatMargin(-50, 100)).toBe('-50%');
    expect(formatMargin(10, 0)).toBe('');
  });
  it('formatCount groups and rounds a plain count', () => {
    expect(formatCount(12345.5)).toBe('12 346');
  });
  it('input helpers follow the same minor-units table', () => {
    expect(formatAmountInput('960.000', 'GNF')).toBe('960 000');
    expect(parseAmountInput('960,000', 'XOF')).toBe(960000);
    expect(formatAmountInput('12,5', 'USD')).toBe('12.5');
    expect(parseAmountInput('1 234,50', 'EUR')).toBe(1234.5);
  });
});

describe('amountInputToCents (carnet bulk entry)', () => {
  it('keeps minor units instead of rounding to whole major units', () => {
    expect(amountInputToCents('10,99', 'USD')).toBe(1099);
    expect(amountInputToCents('10,995', 'USD')).toBe(1100);
    expect(amountInputToCents('10', 'USD')).toBe(1000);
  });
  it('whole-unit currencies', () => {
    expect(amountInputToCents('1099', 'GNF')).toBe(109900);
  });
  it('rejects empty / non-numeric / zero', () => {
    expect(amountInputToCents('', 'USD')).toBeNull();
    expect(amountInputToCents('abc', 'USD')).toBeNull();
    expect(amountInputToCents('0', 'GNF')).toBeNull();
  });
});
