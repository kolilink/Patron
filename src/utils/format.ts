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

export function formatMargin(profit: number, revenue: number): string {
  if (revenue <= 0) return '';
  const pct = ((profit / revenue) * 100).toFixed(0);
  return `${profit >= 0 ? '+' : ''}${pct}%`;
}
