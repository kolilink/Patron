// The cart's arithmetic, in one place, so what the vendor verifies line by line is exactly what the CTA charges.
export interface CartMathLine { unit_price: number; qty: number }

export const lineTotal = (l: CartMathLine): number => l.unit_price * l.qty;
export const cartSum = (lines: CartMathLine[]): number => lines.reduce((s, l) => s + lineTotal(l), 0);

/** "Panier · 3 articles" — one article per line she sees listed. */
export function cartHeaderTitle(lineCount: number): string {
  if (lineCount <= 0) return 'Panier';
  return `Panier · ${lineCount} article${lineCount > 1 ? 's' : ''}`;
}

export type QuickPayMethod = 'especes' | 'orange' | 'mtn';
const QUICK: QuickPayMethod[] = ['especes', 'orange', 'mtn'];

/** The method used for the LAST completed checkout (not the most frequent one): an Orange-Money-heavy vendor lands on Orange Money. */
export function lastUsedPayMethod(history: readonly string[]): QuickPayMethod {
  for (let i = history.length - 1; i >= 0; i--) if ((QUICK as string[]).includes(history[i])) return history[i] as QuickPayMethod;
  return 'especes';
}

/** Remove exactly one line (matched by its key) and nothing else. */
export function withoutLine<T>(lines: T[], keyOf: (l: T) => string, key: string): T[] {
  return lines.filter(l => keyOf(l) !== key);
}
