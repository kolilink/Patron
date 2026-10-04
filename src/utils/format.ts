// ─── Currency minor units (ISO 4217) ─────────────────────────────────────────
// The ONE place that decides how many decimal places a currency has. A new
// country/currency is a new entry here, never new logic. Grouped by exponent
// to keep the table auditable against the ISO 4217 list; the lookup map is
// built from it. A code missing from the table falls back to 2 (the ISO
// default) — add the row rather than special-casing at a call site.
const ISO_4217_EXPONENT_0 = [
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
];
const ISO_4217_EXPONENT_3 = ['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'];
const ISO_4217_EXPONENT_4 = ['CLF', 'UYW'];
const ISO_4217_EXPONENT_2 = [
  'AED', 'AFN', 'ALL', 'AMD', 'ANG', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN', 'BAM', 'BBD', 'BDT', 'BGN', 'BMD', 'BND', 'BOB', 'BOV',
  'BRL', 'BSD', 'BTN', 'BWP', 'BYN', 'BZD', 'CAD', 'CDF', 'CHE', 'CHF', 'CHW', 'CNY', 'COP', 'COU', 'CRC', 'CUC', 'CUP', 'CVE',
  'CZK', 'DKK', 'DOP', 'DZD', 'EGP', 'ERN', 'ETB', 'EUR', 'FJD', 'FKP', 'GBP', 'GEL', 'GHS', 'GIP', 'GMD', 'GTQ', 'GYD', 'HKD',
  'HNL', 'HRK', 'HTG', 'HUF', 'IDR', 'ILS', 'INR', 'IRR', 'JMD', 'KES', 'KGS', 'KHR', 'KPW', 'KYD', 'KZT', 'LAK', 'LBP', 'LKR',
  'LRD', 'LSL', 'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP', 'MRU', 'MUR', 'MVR', 'MWK', 'MXN', 'MXV', 'MYR', 'MZN', 'NAD',
  'NGN', 'NIO', 'NOK', 'NPR', 'NZD', 'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN', 'QAR', 'RON', 'RSD', 'RUB', 'SAR', 'SBD', 'SCR',
  'SDG', 'SEK', 'SGD', 'SHP', 'SLE', 'SOS', 'SRD', 'SSP', 'STN', 'SVC', 'SYP', 'SZL', 'THB', 'TJS', 'TMT', 'TOP', 'TRY', 'TTD',
  'TWD', 'TZS', 'UAH', 'USD', 'USN', 'UYU', 'UZS', 'VED', 'VES', 'WST', 'XCD', 'YER', 'ZAR', 'ZMW', 'ZWL',
];

const MINOR_UNITS: Record<string, number> = {};
for (const c of ISO_4217_EXPONENT_2) MINOR_UNITS[c] = 2;
for (const c of ISO_4217_EXPONENT_0) MINOR_UNITS[c] = 0;
for (const c of ISO_4217_EXPONENT_3) MINOR_UNITS[c] = 3;
for (const c of ISO_4217_EXPONENT_4) MINOR_UNITS[c] = 4;

/** Decimal places a currency displays (ISO 4217 minor units; unknown code → 2). */
export function minorUnits(currency: string): number {
  return MINOR_UNITS[(currency || '').toUpperCase()] ?? 2;
}

/**
 * Deterministic round-half-up to `decimals` places, symmetric around zero
 * (2.5 → 3, -2.5 → -3 — a refund of X shows as the mirror of a sale of X).
 * Works on the number's shortest decimal representation, not its binary
 * value, so 1.005 → 1.01 at 2 places (Math.round(1.005 * 100) gives 1.00).
 * Returns a plain number; never -0.
 */
export function roundHalfUp(n: number, decimals = 0): number {
  if (!Number.isFinite(n)) return 0;
  const abs = Math.abs(n);
  const [mantissa, exp = '0'] = abs.toExponential().split('e');
  const scaled = Number(`${mantissa}e${Number(exp) + decimals}`);
  const rounded = Math.round(scaled); // scaled >= 0, so Math.round is half-up
  // Exponent-string parse keeps the decimal exact; astronomically large values
  // (>= 1e21, where String() switches to exponent form) fall back to division.
  const asText = `${rounded}e${-decimals}`;
  const result = rounded < 1e21 ? Number(asText) : rounded / 10 ** decimals;
  return n < 0 && result !== 0 ? -result : 0 + result;
}

const NBSP = '\u00A0';
const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);

// Digit string of a non-negative integer, never in exponent form.
function integerDigits(n: number): string {
  if (n < 1e21) return n.toString();
  return typeof BigInt === 'function' ? BigInt(n).toString() : n.toLocaleString('fullwide', { useGrouping: false });
}

/**
 * The number part of an amount ("1 234", "1 234.50"), no currency, no sign
 * for zero. Decimal places come from the currency's ISO 4217 minor units; a
 * fractional part that is all zeros is dropped. This and formatAmount are the
 * only functions allowed to turn a money number into text — enforced by
 * __tests__/money-format-guard.test.ts.
 */
export function formatAmountValue(n: number, currency: string): string {
  const decimals = minorUnits(currency);
  const rounded = roundHalfUp(n, decimals);
  const scaled = Math.round(Math.abs(rounded) * 10 ** decimals); // exact: rounded has <= `decimals` places
  let digits = integerDigits(scaled);
  if (decimals > 0) digits = digits.padStart(decimals + 1, '0');
  const intPart = decimals > 0 ? digits.slice(0, -decimals) : digits;
  const decPart = decimals > 0 ? digits.slice(-decimals) : '';
  const sign = rounded < 0 ? '-' : '';
  const body = /^0*$/.test(decPart) ? group(intPart) : `${group(intPart)}.${decPart}`;
  return `${sign}${body}`;
}

export function formatAmount(n: number, currency: string): string {
  return `${formatAmountValue(n, currency)} ${currency}`;
}

/** A plain count (units sold, pieces): rounded half-up, grouped by thousands. Not money — no currency. */
export function formatCount(n: number): string {
  const rounded = roundHalfUp(n, 0);
  return `${rounded < 0 ? '-' : ''}${group(integerDigits(Math.abs(rounded)))}`;
}

/** formatAmount with an explicit "+" for gains ("+1 000 GNF", "-500 GNF", "0 GNF"). */
export function formatSignedAmount(n: number, currency: string): string {
  const text = formatAmount(n, currency);
  return roundHalfUp(n, minorUnits(currency)) > 0 ? `+${text}` : text;
}

/**
 * Format a raw string from a numeric TextInput with spaces every 3 digits.
 * Handles both integer amounts (GNF) and decimal amounts (e.g. 1 234.56).
 * Safe to call on paste: strips all spaces first, then reformats.
 *
 * `currency` is required and must agree with `minorUnits` (ISO 4217)
 * handling — a whole-unit currency (GNF, XOF, …) has no fractional subunit,
 * so a '.' or ',' the user types is always a thousands-grouping mistake
 * (Guinea merchants commonly type "960.000" or "960,000" to mean 960 000),
 * never a decimal point. Treating it as a decimal point silently truncates
 * the amount by ~1000x (regression: a merchant-reported sale showed "960
 * GNF" cash received for an intended "960 000" — this function used to
 * accept comma/period as a decimal separator unconditionally, so
 * "960,000"/"960.000" parsed to 960). For a real decimal currency, comma/
 * period is still treated as the decimal separator, same as before.
 *
 * Usage:
 *   onChangeText={v => setAmountStr(formatAmountInput(v, currency))}
 *   value={amountStr}
 *   // on submit: parseAmountInput(amountStr, currency) → number
 */
export function formatAmountInput(raw: string, currency: string): string {
  if (minorUnits(currency) === 0) {
    const digitsOnly = raw.replace(/[^\d]/g, '');
    if (!digitsOnly) return '';
    return digitsOnly.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }
  // Decimal currency — comma or period is a real decimal separator.
  const normalized = raw.replace(/,/g, '.').replace(/[^\d.]/g, '');
  const dotIdx = normalized.indexOf('.');
  if (dotIdx === -1) {
    // Integer
    if (!normalized) return '';
    return normalized.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }
  // Has decimal part — only format the integer portion
  const intPart = normalized.slice(0, dotIdx);
  const decPart = normalized.slice(dotIdx); // includes the dot
  const formattedInt = intPart ? intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : '';
  return formattedInt + decPart;
}

/** Parse a formatted amount string back to a number. See formatAmountInput for why `currency` is required. */
export function parseAmountInput(formatted: string, currency: string): number {
  if (minorUnits(currency) === 0) {
    const digitsOnly = formatted.replace(/[^\d]/g, '');
    const n = parseInt(digitsOnly, 10);
    return isNaN(n) ? 0 : n;
  }
  const clean = formatted.replace(/\s/g, '').replace(',', '.');
  const n = parseFloat(clean);
  return isNaN(n) ? 0 : n;
}

export function formatMargin(profit: number, revenue: number): string {
  if (revenue <= 0) return '';
  const pct = roundHalfUp((profit / revenue) * 100, 0);
  return `${pct > 0 ? '+' : ''}${pct}%`;
}

/** Format a seconds count as "m:ss" for countdown displays. */
export function formatCountdown(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Plain-text share targets (SMS, WhatsApp, Share sheet previews) have no rich-text
// API — swapping each character for its Mathematical Sans-Serif Bold Unicode
// codepoint is the standard trick to render "bold" text there. Only A-Z/0-9 are
// mapped since referral codes are uppercase hex (see generate_business_referral_code
// in migration_v130.sql); any other character passes through unchanged.
const BOLD_UPPER_BASE = 0x1D5D4; // Mathematical Sans-Serif Bold Capital A
const BOLD_DIGIT_BASE = 0x1D7EC; // Mathematical Sans-Serif Bold Digit Zero

export function toUnicodeBold(text: string): string {
  return text.replace(/[A-Z0-9]/g, char => {
    if (char >= '0' && char <= '9') {
      return String.fromCodePoint(BOLD_DIGIT_BASE + (char.charCodeAt(0) - 48));
    }
    return String.fromCodePoint(BOLD_UPPER_BASE + (char.charCodeAt(0) - 65));
  });
}
