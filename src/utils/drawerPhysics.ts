// Pure maths for the business drawer (BusinessDrawer). Kept free of React /
// Reanimated so the rules — and their numbers — are unit-testable. Mirrors
// sheetGesture.ts, the drag-to-dismiss sheet's util.
//
// Why a spring and not the fixed-duration timing this replaced: a timing
// curve always takes its full duration, whatever the finger did — a hard
// flick and a gentle release animated identically, which is what read as
// "resistant". A spring starts fast, and on a gesture release it inherits
// the finger's velocity, so the panel continues at the hand's own speed.
// The wobble an earlier spring showed was under-damping; this configuration
// is near-critically damped (see drawerDampingRatio), so it settles with no
// visible overshoot.

/** Spring configuration for every drawer settle (open, close, spring-back). */
export const DRAWER_SPRING = { stiffness: 320, damping: 34, mass: 1 } as const;

/** Damping ratio ζ = c / (2√(km)). ζ ≥ ~0.9 shows no perceptible overshoot. */
export function drawerDampingRatio(): number {
  return DRAWER_SPRING.damping / (2 * Math.sqrt(DRAWER_SPRING.stiffness * DRAWER_SPRING.mass));
}

/** Release velocity (px/s) past which the fling alone decides the target. */
export const DRAWER_FLING_VELOCITY = 500;

/** Fraction of the drawer's width a drag must travel to flip its state. */
export const DRAWER_TRAVEL_FRACTION = 0.35;

/** The panel follows the finger 1:1, clamped between fully closed and fully open. */
export function clampDrawerX(x: number, width: number): number {
  return Math.min(0, Math.max(-width, x));
}

/**
 * Where a released drag settles: 0 (open) or -width (closed).
 * A fling decides first; otherwise the drag must have travelled
 * DRAWER_TRAVEL_FRACTION of the width FROM THE STATE IT STARTED IN —
 * an open drawer closes past 35% dragged shut (the behaviour vendors
 * already know), a closed one opens past 35% dragged in.
 */
export function drawerReleaseTarget(
  currentX: number,
  velocityX: number,
  dragStartX: number,
  width: number,
): number {
  if (velocityX <= -DRAWER_FLING_VELOCITY) return -width;
  if (velocityX >= DRAWER_FLING_VELOCITY) return 0;
  const startedOpen = dragStartX > -width / 2;
  if (startedOpen) {
    return currentX < -width * DRAWER_TRAVEL_FRACTION ? -width : 0;
  }
  return currentX > -width * (1 - DRAWER_TRAVEL_FRACTION) ? 0 : -width;
}
