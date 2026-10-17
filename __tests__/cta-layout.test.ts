import fs from 'fs';
import path from 'path';
import { footerPlacement, reservedFooterHeight, scrollBottomPadding } from '@/src/utils/ctaLayout';
import { spacing } from '@/src/theme/spacing';

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

/** What the vendor sees: the scroll content's last element ("Plus d'informations") vs the docked CTA's top edge. */
function visibleGap(o: { keyboardOpen: boolean; mode?: 'flow' | 'sticky'; footerH: number; contentPad: number }) {
  const placement = footerPlacement({ hasFooter: true, mode: o.mode, keyboardOpen: o.keyboardOpen });
  const reserved = scrollBottomPadding(placement, o.footerH, spacing[4]);
  const pad = reserved ?? o.contentPad;
  return { placement, pad, lastElementClearsCta: placement !== 'docked' || pad >= o.footerH + spacing[4] };
}

describe('CTA placement (shared by FormSheet and GestureSheet)', () => {
  it('keyboard closed → the CTA ends the form inside the scroll content (no pinned dead gap)', () => {
    expect(footerPlacement({ hasFooter: true, keyboardOpen: false })).toBe('flow');
    expect(scrollBottomPadding('flow', 90, spacing[4])).toBeNull();
  });
  it('keyboard open → the CTA docks above the keyboard AND scroll content reserves its measured height + one spacing', () => {
    const v = visibleGap({ keyboardOpen: true, footerH: 84, contentPad: 16 });
    expect(v.placement).toBe('docked');
    expect(v.pad).toBe(84 + spacing[4]);
    expect(v.lastElementClearsCta).toBe(true); // "Plus d'informations" can scroll fully above "Ajouter"
  });
  it('the reserved padding tracks whatever height was measured (no hardcoded heights)', () => {
    for (const h of [56, 72, 120]) expect(scrollBottomPadding('docked', h, spacing[4])).toBe(h + spacing[4]);
  });
  it('sticky is always docked, keyboard or not; non-scrollable sheets dock too', () => {
    expect(footerPlacement({ hasFooter: true, mode: 'sticky', keyboardOpen: false })).toBe('docked');
    expect(footerPlacement({ hasFooter: true, keyboardOpen: false, scrollable: false })).toBe('docked');
  });
  it('no footer → nothing', () => {
    expect(footerPlacement({ hasFooter: false, keyboardOpen: true })).toBe('none');
  });
});

describe('GestureSheet wires the rule (and keeps its other behaviour)', () => {
  const g = read('src/components/ui/GestureSheet.tsx');
  it('flow footer renders inside the ScrollView; docked footer is the transparent dock with CtaFade', () => {
    expect(g).toContain("{placement === 'flow' ? <View onLayout={onFlowLayout}>{footerNode}</View> : null}");
    expect(g).toContain("placement === 'docked' ?");
    expect(g).toContain('<CtaFade>{footerNode}</CtaFade>');
    expect(g).toContain('onLayout={onDockLayout}');
    const dock = g.slice(g.indexOf('footerDock:'), g.indexOf('footerDock:') + 160);
    expect(dock).not.toMatch(/backgroundColor|border|shadow/);
  });
  it('sticky requires a reason; gesture, keyboard tracking and Modal flags are untouched', () => {
    expect(g).toContain('needs a stickyReason');
    expect(g).toContain('Gesture.Pan()');
    expect(g).toContain('navigationBarTranslucent');
    // keyboard tracking now lives in the shared hook (one source of truth for both sheets)
    expect(g).toContain('useDockedFooter(');
    expect(read('src/hooks/useDockedFooter.ts')).toContain('Keyboard.addListener');
  });
  it('FormSheet uses the same helper', () => {
    expect(read('src/components/ui/FormSheet.tsx')).toContain('useDockedFooter(');
  });
  it('QuickAddProductSheet keeps its transparent footer and the rapid-add loop (stays open, toast)', () => {
    const qa = read('src/components/QuickAddProductSheet.tsx');
    expect(qa).toContain('<GestureSheet');
    expect(qa).not.toContain('footerMode="sticky"');
    expect(qa).toContain("backgroundColor: 'transparent'");
  });
});

describe('docked footer room, keyboard and close (FormSheet + GestureSheet)', () => {
  const g = read('src/components/ui/GestureSheet.tsx');
  const f = read('src/components/ui/FormSheet.tsx');
  const hook = read('src/hooks/useDockedFooter.ts');

  it('docked: the reserved bottom room equals the measured footer height (+ gap); flow reserves nothing', () => {
    for (const h of [56, 88, 140]) {
      expect(scrollBottomPadding('docked', reservedFooterHeight(h, 999), 16)).toBe(h + 16);
    }
    expect(scrollBottomPadding('flow', reservedFooterHeight(88, 88), 16)).toBeNull();
    expect(scrollBottomPadding('none', reservedFooterHeight(88, 88), 16)).toBeNull();
  });
  it('the first docked frame already reserves the height measured in the flow (no 0 → N second pass)', () => {
    expect(reservedFooterHeight(null, 96)).toBe(96);
    expect(reservedFooterHeight(null, null)).toBe(0);
    expect(reservedFooterHeight(72, 96)).toBe(72); // once docked, the docked measure wins
  });
  it('GestureSheet applies the reserve to the scroll content and measures flow + dock', () => {
    expect(g).toMatch(/reservedPadding != null \? \{ paddingBottom: reservedPadding \} : null/);
    expect(hook).toContain('onFlowLayout');
    expect(hook).toContain('onDockLayout');
  });
  it('FormSheet keeps the docked CTA a layout sibling of the scroll area (it cannot overlay, so no inset is stacked on top)', () => {
    expect(f).not.toMatch(/position:\s*'absolute'/);
    expect(f).toMatch(/<\/SafeAreaView>\s*\{dockedFooter \?/);
  });
  it('every close path drops the keyboard: FormSheet (Annuler, back, programmatic) and GestureSheet (all dismissals)', () => {
    expect(f).toContain('Keyboard.dismiss(); onClose();');
    expect(f).toContain('onRequestClose={handleClose}');
    expect(f).toContain('onPress={handleClose}');
    expect(f).toMatch(/if \(!visible\) Keyboard\.dismiss\(\)/);
    expect(g).toMatch(/finishClose = useCallback\(\(\) => \{[^}]*Keyboard\.dismiss\(\);[^}]*onClose\(\)/s);
    expect(g).toMatch(/requestClose = useCallback\(\(\) => \{[^}]*Keyboard\.dismiss\(\)/s);
    expect(g).toMatch(/else if \(rendered\) \{\s*Keyboard\.dismiss\(\)/);
  });
  it('one keyboard source: no screen tracks the keyboard to style a sheet footer; QuickAdd reads it from the sheet', () => {
    const qa = read('src/components/QuickAddProductSheet.tsx');
    expect(qa).not.toContain('useKeyboardVisible');
    expect(qa).toMatch(/footer=\{keyboardUp => \(/);
  });
});
