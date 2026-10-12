// Vendre's floating cluster: ONE vertical column, right-aligned — "+" on top, a slimmer "Gérer" pill
// beneath. Geometry is tested as numbers; the wiring (order, gating, behaviour) is pinned at source level
// because this repo has no component-render harness.

import fs from 'fs';
import path from 'path';
import {
  FAB_CLUSTER_GAP, FAB_CLUSTER_HEIGHT, FAB_MIN_TOUCH, FAB_PILL_HEIGHT, FAB_PILL_HIT_SLOP, FAB_PLUS_SIZE,
  clusterFits, clusterTop, gridBottomPadding, pillTouchHeight,
} from '@/src/utils/fabCluster';
import { FLOATING_TAB_BAR_CLEARANCE, FLOATING_TAB_BAR_GAP, FLOATING_TAB_BAR_HEIGHT } from '@/src/theme/spacing';

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');
const vendre = read('app/(app)/(tabs)/vendre.tsx');
const cluster = vendre.slice(vendre.indexOf('{showFloating && ('), vendre.indexOf('</Screen>', vendre.indexOf('{showFloating && (')));
const SP4 = 16; const SP2 = 8;
const floatingBottom = (cartPanelHeight: number | null) => FLOATING_TAB_BAR_CLEARANCE + SP4 + (cartPanelHeight ? cartPanelHeight + SP2 : 0);

describe('sizes', () => {
  it('the "+" is untouched: still 52 × 52', () => {
    expect(FAB_PLUS_SIZE).toBe(52);
    expect(vendre).toMatch(/addFab: \{\s*\n\s*width: FAB_PLUS_SIZE, height: FAB_PLUS_SIZE, borderRadius: radius\.full/);
    expect(vendre).toContain('backgroundColor: p.primary, ...shadow.md');          // same purple + elevation
    expect(vendre).toContain('<Ionicons name="add" size={26} color={palette.textInverse} />');
  });
  it('the pill is slimmer than the old 44, but its touch target stays ≥ 48 dp', () => {
    expect(FAB_PILL_HEIGHT).toBeLessThan(44);
    expect(FAB_PILL_HEIGHT).toBe(36);
    expect(pillTouchHeight()).toBeGreaterThanOrEqual(FAB_MIN_TOUCH);
    expect(pillTouchHeight()).toBe(FAB_PILL_HEIGHT + 2 * FAB_PILL_HIT_SLOP);
    expect(cluster).toContain('hitSlop={{ top: FAB_PILL_HIT_SLOP, bottom: FAB_PILL_HIT_SLOP, left: FAB_PILL_HIT_SLOP, right: FAB_PILL_HIT_SLOP }}');
    expect(vendre).toMatch(/gererPill: \{[^}]*height: FAB_PILL_HEIGHT/s);
  });
  it('one step down in weight: smaller icon and caption text instead of label', () => {
    expect(cluster).toContain('<Ionicons name="options-outline" size={16} color={palette.textSecondary} />');
    expect(cluster).toContain('<Text variant="caption" style={{ fontFamily: fontFamily.medium }}>Gérer</Text>');
  });
  it('never icon-only: the sliders icon AND the "Gérer" text are both there', () => {
    expect(cluster).toContain('name="options-outline"');
    expect(cluster).toMatch(/>Gérer<\/Text>/);
  });
  it('thumb separation: the two touch targets do not touch (gap > both hit slops combined)', () => {
    expect(FAB_CLUSTER_GAP).toBeGreaterThanOrEqual(12);
    expect(FAB_CLUSTER_GAP).toBeGreaterThan(FAB_PILL_HIT_SLOP);                   // the pill's slop can't reach into the "+"
    expect(FAB_CLUSTER_HEIGHT).toBe(FAB_PLUS_SIZE + FAB_CLUSTER_GAP + FAB_PILL_HEIGHT);
  });
});

describe('layout: one vertical column, "+" on top, "Gérer" beneath, right-aligned', () => {
  it('the container is a right-anchored column', () => {
    expect(vendre).toMatch(/floatingActions: \{\s*\n\s*position: 'absolute', right: spacing\[5\], flexDirection: 'column', alignItems: 'flex-end', gap: FAB_CLUSTER_GAP,/);
  });
  it('"+" is rendered before the pill (so it is on top in a column)', () => {
    expect(cluster.indexOf('styles.addFab')).toBeGreaterThan(-1);
    expect(cluster.indexOf('styles.gererPill')).toBeGreaterThan(cluster.indexOf('styles.addFab'));
  });
  it('the cluster\'s bottom edge keeps the old anchor above the tab bar / cart panel', () => {
    expect(vendre).toContain('const floatingBottom = FLOATING_TAB_BAR_CLEARANCE + spacing[4] + (cart.length > 0 ? cartPanelHeight + spacing[2] : 0);');
    expect(cluster).toContain('{ bottom: floatingBottom }');
  });
});

describe('no overlap', () => {
  it('the cluster\'s lowest edge (the pill) clears the tab bar, with or without the cart panel', () => {
    const tabBarTop = FLOATING_TAB_BAR_HEIGHT + FLOATING_TAB_BAR_GAP;
    expect(floatingBottom(null)).toBeGreaterThan(tabBarTop);
    expect(floatingBottom(220)).toBeGreaterThan(tabBarTop);
    // the pill's TOUCH area (hit slop) clears it too
    expect(floatingBottom(null) - FAB_PILL_HIT_SLOP).toBeGreaterThan(tabBarTop);
  });
  it('the "+" rises by the pill + gap, so a pill UNDER the old anchor (which would hit the tab bar) is not needed', () => {
    expect(clusterTop(floatingBottom(null))).toBe(floatingBottom(null) + FAB_PLUS_SIZE + FAB_CLUSTER_GAP + FAB_PILL_HEIGHT);
  });
  it.each([568, 640, 667, 736, 812])('fits under the screen header on a %i dp-tall window (statusbar excluded), with and without the cart panel', (h) => {
    const container = h - 24;
    expect(clusterFits(container, floatingBottom(null))).toBe(true);
    expect(clusterFits(container, floatingBottom(220))).toBe(true);
  });
  it('the grid scrolls clear of the cluster: its bottom padding is above the cluster\'s top edge', () => {
    for (const cart of [null, 220]) {
      expect(gridBottomPadding(floatingBottom(cart))).toBeGreaterThan(clusterTop(floatingBottom(cart)));
    }
    expect(vendre).toContain('gridBottomPadding(');
    expect(vendre).toMatch(/canManage && \{ paddingBottom: Math\.max\(/);
  });
});

describe('behaviour and gating unchanged', () => {
  it('"+" opens the quick-add sheet; "Gérer" opens Gérer mode with the same haptic', () => {
    expect(cluster).toMatch(/onPress=\{\(\) => productSheets\.openAdd\(\)\}\s*\n\s*style=\{\(\{ pressed \}\) => \[styles\.addFab/);
    expect(cluster).toMatch(/onPress=\{\(\) => \{ haptics\.select\(\); setGerer\(true\); \}\}/);
    expect(cluster).toContain('accessibilityLabel="Ajouter un produit"');
    expect(cluster).toContain('accessibilityLabel="Gérer les produits"');
  });
  it('role gating: admin/manager see both; a vendeur sees NEITHER (only managers can add or manage products — unchanged)', () => {
    expect(vendre).toContain("const canManage = role === 'administrateur' || role === 'manager';");
    expect(vendre).toContain('const showFloating = canManage && products.length > 0 && !anySheetOpen;');
    // the two buttons share one gate: there is no per-button condition that could show "+" alone
    expect(cluster.match(/canManage|isVendeur/g)).toBeNull();
  });
  it('both hide behind any open sheet (one derived state)', () => {
    expect(vendre).toMatch(/const anySheetOpen = productSheets\.anySheetOpen \|\| variantPickerProduct !== null \|\| showPayment \|\|\s*\n\s*showConfirmSheet \|\| showCartSheet \|\| showQuickCapture \|\| receiptOpen !== null;/);
  });
});
