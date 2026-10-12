// Geometry of Vendre's floating action cluster (admin/manager): one vertical column, right-aligned —
// the purple "+" on top, the quieter "Gérer" pill directly beneath it. Kept as plain numbers so the
// layout rules (sizes, touch target, room above the tab bar) are unit-testable.

import { spacing } from '@/src/theme/spacing';

/** The "+" circle. Unchanged from the side-by-side layout. */
export const FAB_PLUS_SIZE = 52;
/** The "Gérer" pill's VISIBLE height: slimmer than the old 44. */
export const FAB_PILL_HEIGHT = 36;
/** Extra tappable margin around the pill, so the touch target stays ≥ FAB_MIN_TOUCH. */
export const FAB_PILL_HIT_SLOP = 6;
/** Minimum touch target (dp). */
export const FAB_MIN_TOUCH = 48;
/** Thumb separation between the "+" and the pill (their touch targets stay separate). */
export const FAB_CLUSTER_GAP = spacing[3];
/** Total height of the column. */
export const FAB_CLUSTER_HEIGHT = FAB_PLUS_SIZE + FAB_CLUSTER_GAP + FAB_PILL_HEIGHT;

/** The pill's real touch height (visible height + hit slop on both sides). */
export function pillTouchHeight(): number {
  return FAB_PILL_HEIGHT + 2 * FAB_PILL_HIT_SLOP;
}

/** Distance from the container bottom to the TOP edge of the cluster, given where its bottom edge sits. */
export function clusterTop(bottom: number): number {
  return bottom + FAB_CLUSTER_HEIGHT;
}

/**
 * Scroll padding the product grid needs so its last row can scroll clear ABOVE the cluster (the cluster
 * floats over the grid; without this the last tiles would stay hidden behind it).
 */
export function gridBottomPadding(bottom: number): number {
  return clusterTop(bottom) + spacing[3];
}

/** Does the cluster leave room for the screen header above it? (`topReserve` ≈ the Vendre title row + the search field; the container already excludes the status bar.) */
export function clusterFits(containerHeight: number, bottom: number, topReserve = 110): boolean {
  return clusterTop(bottom) <= containerHeight - topReserve;
}
