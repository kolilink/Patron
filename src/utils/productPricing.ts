// Pure product-form arithmetic (display units), extracted from catalogue.tsx
// so the numbers it prints are unit-testable. Rule of this file: a TOTAL is
// built from the amounts actually recorded (quantity bought × the price typed,
// plus the fees typed); per-unit figures are derived FROM totals, only ever
// for information, and are never multiplied back into a total.

/** Landed cost of one unit: unit price plus fees spread over the units bought (qty is at least 1). */
export function perUnitCost(purchasePrice: number, fees: number, qty: number): number {
  return purchasePrice + fees / Math.max(qty, 1);
}

/** Total actually invested: units × price paid, plus fees. Not perUnitCost × qty. */
export function totalInvested(qty: number, purchasePrice: number, fees: number): number {
  return qty * purchasePrice + fees;
}

/** Profit on one unit at the given sale price. Informational — format with formatAmount. */
export function unitProfit(salePrice: number, unitCost: number): number {
  return salePrice - unitCost;
}
