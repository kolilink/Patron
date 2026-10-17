// The cart's arithmetic, in one place, so what the vendor verifies line by line is exactly what the CTA charges.
export interface CartMathLine { unit_price: number; qty: number; agreed_unit_price?: number }

/** The price per piece actually charged: the price agreed out loud with the customer, else the catalogue price. */
export const effectiveUnitPrice = (l: CartMathLine): number => l.agreed_unit_price ?? l.unit_price;
export const hasAgreedPrice = (l: CartMathLine): boolean => l.agreed_unit_price != null;
/** What the line would come to at the catalogue price (shown struck through once a price is agreed). */
export const catalogLineTotal = (l: CartMathLine): number => l.unit_price * l.qty;
/** Agreeing the catalogue price again is "no agreement": returns the value to store (undefined = normal state). */
export function normalizeAgreedPrice(catalogPrice: number, agreed: number | null | undefined): number | undefined {
  if (agreed == null || !Number.isFinite(agreed) || agreed <= 0) return undefined;
  return agreed === catalogPrice ? undefined : agreed;
}

export const lineTotal = (l: CartMathLine): number => effectiveUnitPrice(l) * l.qty;
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
