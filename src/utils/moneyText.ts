// The pure half of <Money>/<MoneyText>: what text a money figure shows and at what size. All sizing lives here (no
// layout reads, no native autosize) so it is deterministic and unit-testable — the component is a thin wrapper.
import { formatAmount, formatAmountValue, formatSignedAmount } from '@/src/utils/format';

/** Below this a figure stops being readable in sunlight; we clip rather than shrink past it. */
export const MIN_MONEY_FONT = 11;
/** Never shrink below this share of the design size either (the old minimumFontScale). */
export const MIN_MONEY_SCALE = 0.5;
export const SCREEN_GUTTER = 32;     // 16dp each side
export const MASK = '•••••';

/** Advance widths in em for DM Sans Bold with tabular figures — deliberately a touch wide so we shrink early, never clip. */
const EM = { digit: 0.64, space: 0.32, upper: 0.76, lower: 0.62, punct: 0.36, mask: 0.5 };

export function estimateTextWidth(text: string, fontSize: number): number {
  let em = 0;
  for (const ch of text) {
    if (/\d/.test(ch)) em += EM.digit;
    else if (/[\s  ]/.test(ch)) em += EM.space;
    else if (ch === '•') em += EM.mask;
    else if (/[A-Z]/.test(ch)) em += EM.upper;
    else if (/[a-zà-ÿ]/i.test(ch)) em += EM.lower;
    else em += EM.punct;
  }
  return em * fontSize;
}

export type MoneyFit = 'full' | 'half' | number;

/** Width a figure may use. 'full' = a screen-wide block (hero numbers); 'half' = beside a label in a row. */
export function moneyBudget(windowWidth: number, baseFontSize: number, fit?: MoneyFit): number {
  const full = Math.max(120, windowWidth - SCREEN_GUTTER - 32); // minus the usual card padding
  if (typeof fit === 'number') return fit;
  const mode = fit ?? (baseFontSize >= 24 ? 'full' : 'half');
  return mode === 'full' ? full : full * 0.55;
}

export interface FittedMoney { fontSize: number; lineHeight: number; fits: boolean }

/** Largest size ≤ base at which `text` fits `budget`, never below the readable floor. */
export function fitMoney(text: string, baseFontSize: number, baseLineHeight: number, budget: number): FittedMoney {
  const floor = Math.max(MIN_MONEY_FONT, baseFontSize * MIN_MONEY_SCALE);
  const want = estimateTextWidth(text, baseFontSize);
  let size = want <= budget ? baseFontSize : baseFontSize * (budget / want);
  size = Math.min(baseFontSize, Math.max(floor, Math.floor(size * 2) / 2));
  return {
    fontSize: size,
    lineHeight: Math.round(baseLineHeight * (size / baseFontSize)),
    fits: estimateTextWidth(text, size) <= budget + 0.5,
  };
}

/** A money amount as a finite number, or NaN when it isn't one (loudly rejected by the caller). Numeric strings are coerced. */
export function toAmount(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return NaN;
}

export interface AmountTextOptions {
  signed?: boolean;      // "+1 000 GNF"
  valueOnly?: boolean;   // "1 000" (no currency) — the currency is rendered elsewhere
  masked?: boolean;      // privacy mode
  prefix?: string;       // "Reste : "
  suffix?: string;       // " /pièce"
}

/** The one place an amount becomes text. Returns '—' (never "NaN GNF", never an unformatted raw number) for a bad value. */
export function amountText(amount: unknown, currency: string, o: AmountTextOptions = {}): string {
  const n = toAmount(amount);
  const core = o.masked ? (o.valueOnly ? MASK : `${MASK} ${currency}`)
    : !Number.isFinite(n) ? '—'
    : o.valueOnly ? formatAmountValue(n, currency)
    : o.signed ? formatSignedAmount(n, currency)
    : formatAmount(n, currency);
  return `${o.prefix ?? ''}${core}${o.suffix ?? ''}`;
}

/** Children of a MoneyText → one string. Anything that is not text/number is a bug, not something to guess at. */
export function childrenToText(children: unknown): string {
  if (children == null || typeof children === 'boolean') return '';
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(childrenToText).join('');
  throw new Error('MoneyText children must be text — pass an <Money amount/> or a plain string');
}

export interface MoneyTextProps {
  text: string;
  fontSize: number;
  lineHeight: number;
  fits: boolean;
}

/** Everything the component needs: the final string and size. Pure; this is what a vendor sees. */
export function moneyTextProps(args: {
  text: string; baseFontSize: number; baseLineHeight: number; windowWidth: number; fit?: MoneyFit;
}): MoneyTextProps {
  const budget = moneyBudget(args.windowWidth, args.baseFontSize, args.fit);
  return { text: args.text, ...fitMoney(args.text, args.baseFontSize, args.baseLineHeight, budget) };
}
