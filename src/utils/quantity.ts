// Quantity stepping rules, shared by every stepper (cart, réception, product
// form). A stepper never produces a nonsense quantity: it stops at `min`
// (default 1 — a zero-quantity line is not a valid state; removal is an
// explicit delete) and at `max` (known stock) when there is one.

export interface StepBounds {
  min?: number;
  max?: number;
}

export function clampQuantity(value: number, { min = 1, max }: StepBounds = {}): number {
  let v = Number.isNaN(value) ? min : value; // Infinity is a real (huge) number: it clamps to max
  if (max !== undefined && v > max) v = max;
  if (v < min) v = min;
  return v;
}

/** Parses a typed quantity ("", "12", "1,5") → number, or null when blank/invalid. */
export function parseQuantity(text: string): number | null {
  const n = parseFloat(String(text).replace(',', '.').trim());
  return Number.isFinite(n) ? n : null;
}

/** Quantity after one stepper tap. `current` may be a typed string; blank counts as 0. */
export function stepQuantity(current: number | string, delta: 1 | -1, bounds: StepBounds = {}): number {
  const base = typeof current === 'number' ? current : (parseQuantity(current) ?? 0);
  return clampQuantity(base + delta, bounds);
}

/** True when a tap in this direction would change nothing (the button should look disabled). */
export function stepIsBlocked(current: number | string, delta: 1 | -1, bounds: StepBounds = {}): boolean {
  const base = typeof current === 'number' ? current : (parseQuantity(current) ?? 0);
  return stepQuantity(base, delta, bounds) === base;
}
