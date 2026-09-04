export const spacing = {
  0: 0,
  0.5: 2,
  1: 4,
  1.5: 6,
  2: 8,
  2.5: 10,
  3: 12,
  3.5: 14,
  4: 16,
  5: 20,
  6: 24,
  7: 28,
  8: 32,
  9: 36,
  10: 40,
  12: 48,
  14: 56,
  16: 64,
  20: 80,
  24: 96,
} as const;

export const radius = {
  sm:   6,
  md:   10,
  lg:   14,
  card: 16,   // canonical card radius — slightly more generous than lg
  xl:   20,
  full: 9999,
} as const;

// Floating detached tab bar (see `(tabs)/_layout.tsx`) — since it's
// `position: 'absolute'`, it no longer reserves its own space in flex
// layout the way a normal tab bar does. Every `<Screen tab>` and any
// absolutely-positioned bottom-anchored element on a tab screen (cart
// checkout bars, FABs) must add `FLOATING_TAB_BAR_CLEARANCE` to their own
// bottom offset to avoid rendering underneath the pill. Kept as one shared
// source of truth so the bar's own position math and every consumer's
// clearance math can never drift apart.
// 64 — scaled back up from 52 once the underlying architecture (centering,
// hidden-tab handling) was confirmed correct and the request became "expand
// it" (TAB_CIRCLE_SIZE grew 36→48 in `(tabs)/_layout.tsx` alongside this) —
// not a reversal of the earlier "too tall" complaint, which was about the
// bar growing around a *fixed* circle rather than both growing together.
// (64-48)/2 = 8px clearance per side, same ratio the 52/36 pairing had.
export const FLOATING_TAB_BAR_HEIGHT = 64;
export const FLOATING_TAB_BAR_GAP = 12; // gap between the pill's bottom edge and the safe-area inset
export const FLOATING_TAB_BAR_CLEARANCE = FLOATING_TAB_BAR_HEIGHT + FLOATING_TAB_BAR_GAP + 12; // + a little breathing room above the pill

export const shadow = {
  sm: {
    shadowColor: '#1E1B4B',  // deep indigo-dark — warmer than pure slate
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 1,
  },
  md: {
    shadowColor: '#1E1B4B',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 8,
    elevation: 3,
  },
  lg: {
    shadowColor: '#1E1B4B',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.10,
    shadowRadius: 16,
    elevation: 8,
  },
} as const;
