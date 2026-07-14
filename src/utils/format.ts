// Whole-unit currencies (no subdivisions): round to integer.
// All others (USD, EUR, …): show 2 decimal places.
const WHOLE_UNIT_CURRENCIES = new Set(['GNF', 'XOF', 'XAF', 'JPY', 'KRW']);

export function formatAmount(n: number, currency: string): string {
  // toLocaleString is unreliable on some Android/Hermes builds — use regex instead.
  if (WHOLE_UNIT_CURRENCIES.has(currency)) {
    const formatted = Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return `${formatted} ${currency}`;
  }
  const [intPart, decPart] = n.toFixed(2).split('.');
  const formatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${formatted}.${decPart} ${currency}`;
}

/**
 * Format a raw string from a numeric TextInput with spaces every 3 digits.
 * Handles both integer amounts (GNF) and decimal amounts (e.g. 1 234.56).
 * Safe to call on paste: strips all spaces first, then reformats.
 *
 * `currency` is required and must match `formatAmount`'s WHOLE_UNIT_CURRENCIES
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
  if (WHOLE_UNIT_CURRENCIES.has(currency)) {
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
  if (WHOLE_UNIT_CURRENCIES.has(currency)) {
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
  const pct = ((profit / revenue) * 100).toFixed(0);
  return `${profit >= 0 ? '+' : ''}${pct}%`;
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
