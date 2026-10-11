// Pure maths for the drag-to-dismiss sheet (GestureSheet). Kept free of React / Reanimated so the
// rules — and their numbers — are unit-testable.

/** Fraction of the sheet's height past which a release dismisses it. */
export const DISMISS_FRACTION = 0.5;
/** Downward release velocity (px/s) that counts as a fling, whatever the distance. */
export const DISMISS_VELOCITY = 900;
/** Backdrop opacity when the sheet is fully open. */
export const BACKDROP_MAX = 0.45;

/** The sheet follows the finger 1:1 downward and never rises above its open position. */
export function dragOffset(translationY: number): number {
  return translationY > 0 ? translationY : 0;
}

/** Release decision: dismiss on a fling OR past half the sheet; otherwise spring back open. */
export function shouldDismiss(offset: number, velocityY: number, sheetHeight: number): boolean {
  if (velocityY >= DISMISS_VELOCITY) return true;
  return sheetHeight > 0 && offset >= sheetHeight * DISMISS_FRACTION;
}

/** Backdrop dim is a pure function of the drag: full when open, none when fully off-screen. */
export function backdropOpacity(offset: number, sheetHeight: number): number {
  if (sheetHeight <= 0) return BACKDROP_MAX;
  const t = Math.min(Math.max(offset / sheetHeight, 0), 1);
  return BACKDROP_MAX * (1 - t);
}
