// Tapping the already-active tab icon goes back to that tab's root — asserted on the state the vendor lands in
// (the product grid, not Gérer), not on "a navigation call fired".
import fs from 'fs';
import path from 'path';
import { emitTabReselect, onTabReselect, resolveReselect } from '@/src/utils/tabReselect';

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

/** A faithful miniature of Vendre's root logic: the same subscription + resolve + the two states the vendor can see. */
function mountVendre(initial: { gerer: boolean; offset: number }) {
  const s = { gerer: initial.gerer, offset: initial.offset, scrolledToTop: false };
  const off = onTabReselect('vendre', () => {
    const action = resolveReselect({ inSubview: s.gerer, scrollOffset: s.offset });
    if (action === 'leave-subview') s.gerer = false;
    else if (action === 'scroll-top') { s.offset = 0; s.scrolledToTop = true; }
  });
  return { s, view: () => (s.gerer ? 'gerer' : 'grid'), unmount: off };
}

describe('tab-bar reselect', () => {
  it('Gérer open → tap the active Vendre tab → the product grid is what is on screen', () => {
    const v = mountVendre({ gerer: true, offset: 0 });
    expect(v.view()).toBe('gerer');
    emitTabReselect('vendre');
    expect(v.view()).toBe('grid');
    v.unmount();
  });
  it('already at the root and scrolled down → scrolls to the top, stays on the grid', () => {
    const v = mountVendre({ gerer: false, offset: 640 });
    emitTabReselect('vendre');
    expect(v.view()).toBe('grid');
    expect(v.s.scrolledToTop).toBe(true);
    expect(v.s.offset).toBe(0);
    v.unmount();
  });
  it('at the root and already at the top → nothing happens (and nothing breaks)', () => {
    const v = mountVendre({ gerer: false, offset: 0 });
    emitTabReselect('vendre');
    expect(v.view()).toBe('grid');
    expect(v.s.scrolledToTop).toBe(false);
    v.unmount();
  });
  it('only the pressed tab reacts; an unmounted tab does not; no listeners is fine', () => {
    const other = jest.fn();
    const off = onTabReselect('index', other);
    const v = mountVendre({ gerer: true, offset: 0 });
    emitTabReselect('vendre');
    expect(other).not.toHaveBeenCalled();
    v.unmount(); off();
    expect(() => emitTabReselect('vendre')).not.toThrow();
  });
  it('resolveReselect: deeper than root wins over scrolling', () => {
    expect(resolveReselect({ inSubview: true, scrollOffset: 900 })).toBe('leave-subview');
    expect(resolveReselect({ inSubview: false, scrollOffset: 900 })).toBe('scroll-top');
    expect(resolveReselect({ inSubview: false, scrollOffset: 0 })).toBe('none');
  });

  describe('wiring', () => {
    it('the tab bar emits on a press of the focused tab, and still navigates when switching tabs', () => {
      const src = read('app/(app)/(tabs)/_layout.tsx');
      expect(src).toContain('} else if (focused && !event.defaultPrevented) {');
      expect(src).toContain('emitTabReselect(route.name)');
      expect(src).toContain('navigation.navigate(route.name');
    });
    it('Vendre leaves Gérer (back to the grid) and scrolls the grid; Accueil and Moi scroll to top', () => {
      const v = read('app/(app)/(tabs)/vendre.tsx');
      expect(v).toContain("onTabReselect('vendre'");
      expect(v).toContain("action === 'leave-subview') exitGerer()");
      expect(v).toContain('gridRef.current?.scrollToOffset({ offset: 0, animated: true })');
      expect(v).toMatch(/if \(gerer && canManage\) \{[\s\S]{0,400}<ProductManager/); // Gérer is the only alternative to the grid
      expect(read('app/(app)/(tabs)/index.tsx')).toContain("onTabReselect('index'");
      expect(read('app/(app)/(tabs)/plus.tsx')).toContain("onTabReselect('plus'");
    });
    it('"< Vendre" / "Terminé" still work (onExit is untouched)', () => {
      expect(read('app/(app)/(tabs)/vendre.tsx')).toContain('<ProductManager sheets={productSheets} onExit={exitGerer} />');
    });
  });
});
