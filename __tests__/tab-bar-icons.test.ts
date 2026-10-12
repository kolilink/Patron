import fs from 'fs';
import path from 'path';
const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const HOME_GLYPH_PATH = /HOME_GLYPH_PATH = '([^']+)'/.exec(read('src/components/ui/FloatingTabBar.tsx'))![1];

describe('tab bar icons', () => {
  const layout = read('app/(app)/(tabs)/_layout.tsx');
  const bar = read('src/components/ui/FloatingTabBar.tsx');
  it('middle tab is the banknote pair, no cart left', () => {
    expect(layout).toContain("outline: 'cash-outline', filled: 'cash'");
    expect(layout).not.toMatch(/cart/);
    expect(layout).toContain("label: 'Vendre'");
  });
  it('home is one plain pentagon: no chimney, no door, no inner lines', () => {
    const subpaths = HOME_GLYPH_PATH.match(/M/g)!.length;
    expect(subpaths).toBe(1);                      // a single closed outline
    expect(HOME_GLYPH_PATH.trim().endsWith('Z')).toBe(true);
    expect(HOME_GLYPH_PATH.match(/[LHV]/g)!.length).toBe(4); // apex, right wall, base, left wall → 5 corners
    expect((bar.match(/<Path /g) || []).length).toBe(1);
  });
  it('outline when inactive, filled when active (both custom and Ionicons glyphs)', () => {
    expect(bar).toContain("fill={focused ? color : 'none'}");
    expect(bar).toContain('name={focused ? filled : outline}');
  });
  it('theme tokens only (both themes follow palette), same 28px size, order and 3 tabs unchanged', () => {
    expect(bar).toContain('const ICON_SIZE = 28;');
    expect(bar).toContain('inactiveColor={palette.tabBarInactive}');
    expect(bar).toContain('activeColor={palette.textPrimary}');
    expect(layout.indexOf("index:")).toBeLessThan(layout.indexOf("vendre:"));
    expect(layout.indexOf("vendre:")).toBeLessThan(layout.indexOf("plus:"));
    expect(layout).toContain("outline: 'person-outline', filled: 'person'");
  });
  it('touch target stays the full slot x bar height (>= 48dp)', () => {
    expect(bar).toMatch(/height: FLOATING_TAB_BAR_HEIGHT/);
    expect(read('src/theme/spacing.ts')).toMatch(/FLOATING_TAB_BAR_HEIGHT = (6\d|[5-9]\d)/);
  });
});
