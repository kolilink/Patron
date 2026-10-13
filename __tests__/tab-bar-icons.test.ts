import fs from 'fs';
import path from 'path';
const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const bar = read('src/components/ui/FloatingTabBar.tsx');
const layout = read('app/(app)/(tabs)/_layout.tsx');
const HOME = /HOME_GLYPH_PATH = '([^']+)'/.exec(bar)![1];
const DOOR = /HOME_DOOR_PATH = '([^']+)'/.exec(bar)![1];
const fn = (name: string) => { const i = bar.indexOf(`function ${name}(`); return bar.slice(i, bar.indexOf('\n}\n', i)); };

describe('tab bar icons (Skool-style home, single-layer banknote)', () => {
  it('home: ONE closed rounded outline (soft corners) + a short horizontal door-dash near the bottom centre', () => {
    expect((HOME.match(/M/g) || []).length).toBe(1);
    expect(HOME.trim().endsWith('Z')).toBe(true);
    expect(HOME).toMatch(/Q/);                       // quadratic curves = soft corners, not hard vertices
    const m = /^M([\d.]+) ([\d.]+) H([\d.]+)$/.exec(DOOR)!;   // horizontal: same y, only an H move
    const [x1, y, x2] = [Number(m[1]), Number(m[2]), Number(m[3])];
    expect(x2 - x1).toBeGreaterThan(3); expect(x2 - x1).toBeLessThan(8);
    expect((x1 + x2) / 2).toBeCloseTo(12, 1);        // centred
    expect(y).toBeGreaterThan(14);                   // near the bottom
  });
  it('home: active is filled with the door CUT OUT (mask); inactive is outline with the door stroked', () => {
    const h = fn('HomeGlyph');
    expect(h).toContain('<Mask');
    expect(h).toContain('mask="url(#homeCut)"');
    expect(h).toContain('fill="none"');
    expect(h).toContain('HOME_DOOR_PATH');
  });
  it('banknote: exactly ONE layer — one rounded rect + one centre circle per variant, no stacked lines', () => {
    const c = fn('CashGlyph');
    expect((c.match(/<Rect \{\.\.\.NOTE_RECT\}/g) || []).length).toBe(2);   // one in outline, one in filled
    expect((c.match(/<Circle \{\.\.\.NOTE_CIRCLE\}/g) || []).length).toBe(2);
    expect(c).not.toMatch(/<Path/);                                         // no extra lines
    const rect = /NOTE_RECT = \{ x: ([\d.]+), y: ([\d.]+), width: ([\d.]+), height: ([\d.]+), rx: ([\d.]+)/.exec(bar)!.map(Number);
    expect(rect[5]).toBeGreaterThan(0);                                     // rounded
    expect(rect[3] / rect[4]).toBeGreaterThan(1.4);                         // reads as a note (wider than tall)
    expect(/cx: ([\d.]+), cy: ([\d.]+)/.exec(bar)!.slice(1).map(Number)).toEqual([rect[1] + rect[3] / 2, rect[2] + rect[4] / 2]); // centred
  });
  it('banknote: active filled with the circle cut out; inactive outline', () => {
    const c = fn('CashGlyph');
    expect(c).toContain('mask="url(#cashCut)"');
    expect(c).toContain('fill="none"');
  });
  it('both wired through the glyph prop, Ionicons names kept only as the type fallback', () => {
    expect(layout).toContain("glyph: 'home'");
    expect(layout).toContain("glyph: 'cash'");
    expect(bar).toContain("glyph === 'cash'");
  });
  it('28px, tab order, third tab and touch targets unchanged', () => {
    expect(bar).toContain('const ICON_SIZE = 28;');
    expect(bar).toContain('size={ICON_SIZE}');
    expect(layout.indexOf('index:')).toBeLessThan(layout.indexOf('vendre:'));
    expect(layout.indexOf('vendre:')).toBeLessThan(layout.indexOf('plus:'));
    expect(layout).toContain("plus: { label: 'Moi', outline: 'person-outline', filled: 'person' }");
    expect(bar).toMatch(/height: FLOATING_TAB_BAR_HEIGHT/);
    expect(read('src/theme/spacing.ts')).toMatch(/FLOATING_TAB_BAR_HEIGHT = (6\d|[5-9]\d)/);
  });
  it('colours still come from the theme tokens (both themes)', () => {
    expect(bar).toContain('activeColor={palette.textPrimary}');
    expect(bar).toContain('inactiveColor={palette.tabBarInactive}');
  });
});
