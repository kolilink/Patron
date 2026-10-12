// The bottom tab bar island: stretched to 16px side margins (margin-based, never a fixed width), a true
// stadium (radius = half the height), 28px icons — layout only. Geometry is tested as numbers; the wiring
// is pinned at source level because this repo has no component-render harness.

import fs from 'fs';
import path from 'path';
import {
  FLOATING_TAB_BAR_CLEARANCE, FLOATING_TAB_BAR_GAP, FLOATING_TAB_BAR_HEIGHT, FLOATING_TAB_BAR_RADIUS,
  FLOATING_TAB_BAR_SIDE_MARGIN, floatingTabBarIslandWidth, floatingTabBarSlotWidth,
} from '@/src/theme/spacing';
import { FAB_PILL_HIT_SLOP } from '@/src/utils/fabCluster';

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');
const bar = read('src/components/ui/FloatingTabBar.tsx');
const layout = read('app/(app)/(tabs)/_layout.tsx');

describe('island width: 16px side margins, margin-based', () => {
  it('16px each side → 358px on a 390px screen', () => {
    expect(FLOATING_TAB_BAR_SIDE_MARGIN).toBe(16);
    expect(floatingTabBarIslandWidth(390)).toBe(390 - 32);
  });
  it.each([320, 360, 375, 390, 412, 430, 768])('island = screen − 32 on a %ipx-wide screen (no fixed width anywhere)', (w) => {
    expect(floatingTabBarIslandWidth(w)).toBe(w - 32);
    // left margin + island + right margin always add back up to the screen: edges line up with the cards
    expect(FLOATING_TAB_BAR_SIDE_MARGIN + floatingTabBarIslandWidth(w) + FLOATING_TAB_BAR_SIDE_MARGIN).toBe(w);
  });
  it('is applied as left/right margins on the bar\'s wrapper, and the consumer no longer passes a fixed width', () => {
    expect(bar).toMatch(/left: FLOATING_TAB_BAR_SIDE_MARGIN,\s*\n\s*right: FLOATING_TAB_BAR_SIDE_MARGIN,/);
    expect(bar).toContain("width: width ?? '100%'");
    expect(layout).not.toMatch(/width=\{/);
    expect(layout).not.toMatch(/barWidthFor|TAB_CIRCLE_SIZE/);
  });
});

describe('capsule', () => {
  it('corner radius equals half the island height (a true stadium), not 9999 and not a rounded rectangle', () => {
    expect(FLOATING_TAB_BAR_RADIUS).toBe(FLOATING_TAB_BAR_HEIGHT / 2);
    expect(bar).toContain('borderRadius: FLOATING_TAB_BAR_RADIUS');
    expect(bar).not.toContain('borderRadius: 9999');
  });
  it('the island is exactly the bar height, so that radius really is half of it', () => {
    expect(bar).toMatch(/overflow: 'hidden',\s*\n\s*height: FLOATING_TAB_BAR_HEIGHT,/);
    expect(FLOATING_TAB_BAR_HEIGHT).toBe(64);                 // unchanged
  });
});

describe('icons and touch targets', () => {
  it('icons are 28px (were 24), icon-only (no labels by default)', () => {
    expect(bar).toContain('const ICON_SIZE = 28;');
    expect(bar).toContain('size={ICON_SIZE}');
    expect(bar).toContain('showLabels = false');
  });
  it.each([320, 360, 390, 430])('3 tabs are distributed evenly on a %ipx screen, each slot ≥ 48px wide and the bar 64px tall', (w) => {
    const slot = floatingTabBarSlotWidth(w, 3);
    expect(slot).toBe((w - 32) / 3);
    expect(slot).toBeGreaterThanOrEqual(48);
    expect(FLOATING_TAB_BAR_HEIGHT).toBeGreaterThanOrEqual(48);
  });
  it('fewer visible tabs (vendeur / investisseur) are still evenly distributed with ≥ 48px slots', () => {
    for (const n of [1, 2, 3]) expect(floatingTabBarSlotWidth(360, n)).toBeGreaterThanOrEqual(48);
  });
  it('slots are equal-width by construction, and the touch target rule is kept', () => {
    expect(bar).toContain('const w = barWidth / n;');
    expect(bar).toContain('const MIN_TAP_TARGET = 48;');
    expect(bar).toContain('width: slotWidth,');
  });
});

describe('unchanged: tabs, order, icons, glow, offset, behaviour', () => {
  it('the same 3 tabs in the same order with the same icons', () => {
    const defs = layout.slice(layout.indexOf('const TAB_DEFS'), layout.indexOf('function CustomTabBar'));
    expect(defs.match(/^\s{2}(index|vendre|plus):/gm)?.map(s => s.trim().replace(':', ''))).toEqual(['index', 'vendre', 'plus']);
    expect(defs).toContain("outline: 'home-outline', filled: 'home'");
    expect(defs).toContain("outline: 'cash-outline', filled: 'cash'");
    expect(defs).toContain("outline: 'person-outline', filled: 'person'");
  });
  it('active-tab glow (the indicator pill) and its glide are untouched', () => {
    expect(bar).toContain('backgroundColor: palette.tabBarIndicator');
    expect(bar).toContain('const SLIDE_DURATION_MS = 120;');
    expect(bar).toContain('const INDICATOR_V_INSET = 8;');
    expect(bar).toContain('const PRESS_SCALE = 0.97;');
  });
  it('bottom offset above the safe area is unchanged', () => {
    expect(bar).toContain('bottom: bottomInset + FLOATING_TAB_BAR_GAP,');
    expect(FLOATING_TAB_BAR_GAP).toBe(4);
    // dynamic inset, not hardcoded: iPhone (34) and Samsung button-nav (48)
    for (const inset of [34, 48, 0]) expect(inset + FLOATING_TAB_BAR_GAP).toBe(inset + 4);
    expect(FLOATING_TAB_BAR_CLEARANCE).toBe(FLOATING_TAB_BAR_HEIGHT + FLOATING_TAB_BAR_GAP + 12);
  });
  it('tab switching behaviour is unchanged: tabPress is emitted, navigation only if not focused / not prevented', () => {
    expect(layout).toMatch(/navigation\.emit\(\{ type: 'tabPress', target: route\.key, canPreventDefault: true \}\)/);
    expect(layout).toMatch(/if \(!focused && !event\.defaultPrevented\) \{\s*\n\s*navigation\.navigate\(route\.name, route\.params as never\);/);
    expect(bar).toContain('onPress={() => onSelect(i)}');
  });
});

describe('no overlap with page content or the floating "+" cluster', () => {
  // The island keeps its height and bottom offset, so everything that clears it today still clears it:
  // only its width changed.
  const tabBarTop = FLOATING_TAB_BAR_HEIGHT + FLOATING_TAB_BAR_GAP;
  it('page content keeps the same clearance above the island', () => {
    expect(FLOATING_TAB_BAR_CLEARANCE).toBeGreaterThan(tabBarTop);
  });
  it('Vendre\'s "+ / Gérer" cluster still sits above the (now wider) island — its touch area too', () => {
    const clusterBottom = FLOATING_TAB_BAR_CLEARANCE + 16;                 // floatingBottom without the cart panel
    expect(clusterBottom - FAB_PILL_HIT_SLOP).toBeGreaterThan(tabBarTop);
  });
});
