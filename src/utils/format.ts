export function formatAmount(n: number, currency: string): string {
  // toLocaleString is unreliable on some Android/Hermes builds — use regex instead.
  // Inserts a non-breaking space every 3 digits: 10000 → "10 000"
  const formatted = Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${formatted} ${currency}`;
}

export function formatMargin(profit: number, revenue: number): string {
  if (revenue <= 0) return '';
  const pct = ((profit / revenue) * 100).toFixed(0);
  return `${profit >= 0 ? '+' : ''}${pct}%`;
}
