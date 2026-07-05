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
 * Usage:
 *   onChangeText={v => setAmountStr(formatAmountInput(v))}
 *   value={amountStr}
 *   // on submit: parseAmountInput(amountStr) → number
 */
export function formatAmountInput(raw: string): string {
  // Normalize: accept comma as decimal separator
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

/** Parse a formatted amount string back to a number. */
export function parseAmountInput(formatted: string): number {
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
