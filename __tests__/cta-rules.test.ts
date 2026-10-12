import fs from 'fs';
import path from 'path';
const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const styleBlock = (src: string, name: string) => {
  const i = src.search(new RegExp(`\\b${name}:\\s*\\{`));
  expect(i).toBeGreaterThan(-1);
  return src.slice(i, src.indexOf('\n', src.indexOf('}', i) + 1) + 1 > i ? src.indexOf('},', i) + 2 : i + 200);
};

// [file, footer style name]
const FOOTERS: Array<[string, string]> = [
  ['app/(app)/clients/[name].tsx', 'footer'],
  ['app/(app)/fournisseurs/index.tsx', 'mfooter'],
  ['app/(app)/fournisseurs/[id].tsx', 'mfooter'],
  ['app/(app)/fournisseurs/[id].tsx', 'footer'],
  ['app/(app)/fournisseurs/reception.tsx', 'footer'],
  ['app/(app)/apports/index.tsx', 'modalFooter'],
  ['app/(app)/(tabs)/vendre.tsx', 'modalFooter'],
  ['app/(app)/(tabs)/vendre.tsx', 'cartSheetFooter'],
  ['app/(app)/(tabs)/vendre.tsx', 'cartFooter'],
  ['app/(app)/ventes/index.tsx', 'sheetFooter'],
  ['app/(app)/depenses/index.tsx', 'modalFooter'],
  ['app/(app)/equipe/index.tsx', 'mfooter'],
  ['app/(app)/onboarding/carnet.tsx', 'footer'],
  ['src/components/expenses/ExpenseSheet.tsx', 'footer'],
  ['src/components/products/ProductSubSheets.tsx', 'modalFooter'],
  ['src/components/QuickAddProductSheet.tsx', 'footer'],
];

describe('no slab behind a CTA', () => {
  it.each(FOOTERS)('%s .%s has no fill, border or shadow', (file, name) => {
    const b = styleBlock(read(file), name);
    expect(b).not.toMatch(/backgroundColor:\s*(p\.|palette\.|')(?!transparent)/);
    expect(b).not.toMatch(/borderTopWidth|borderTopColor|shadow\./);
  });
  it('keyboard accessory band is transparent', () => {
    expect(read('src/components/ui/SilentKeyboardAccessory.tsx')).toContain('backgroundColor="transparent"');
  });
  it('the only sticky treatment is the CtaFade gradient (transparent → background)', () => {
    const fade = read('src/components/ui/CtaFade.tsx');
    expect(fade).toContain("'rgba(0,0,0,0)', palette.background");
    expect(fade).toContain('pointerEvents="none"');
  });
});

describe('CTA ends the form (no dead gap)', () => {
  const sheet = read('src/components/ui/FormSheet.tsx');
  it('FormSheet puts the footer inside the scroll content by default and docks it only for sticky or an open keyboard', () => {
    expect(sheet).toContain("footerMode = 'flow'");
    expect(sheet).toMatch(/\{flowFooter \? footer : null\}\s*<\/ScrollView>/);
    expect(sheet).toContain("footerMode === 'flow' && !keyboardOpen");
  });
  it('sticky FormSheets always carry a reason', () => {
    expect(sheet).toContain('needs a stickyReason');
    for (const f of ['app/(app)/(tabs)/vendre.tsx']) {
      const src = read(f);
      const n = (src.match(/footerMode="sticky"/g) || []).length;
      expect((src.match(/stickyReason="/g) || []).length).toBe(n);
    }
  });
  it('reception CTAs are inside their ScrollView, directly after the last element', () => {
    const r = read('app/(app)/fournisseurs/reception.tsx');
    expect(r).not.toMatch(/<\/ScrollView>\s*<View style=\{styles\.footer\}>/);
    expect(r.match(/<View style=\{styles\.footer\}>[\s\S]{0,200}?<\/View>\s*<\/ScrollView>/g)!.length).toBe(2);
  });
  it('no flex spacer pushes the first-run payoff CTA to the bottom; carnet CTA ends its list', () => {
    expect(read('src/components/FirstRunHeroOverlay.tsx')).toContain('payoffSpacer: { height: spacing[8] }');
    expect(read('app/(app)/onboarding/carnet.tsx')).toContain('ListFooterComponent');
  });
  it('remaining sticky CTAs state why', () => {
    expect(read('app/(app)/fournisseurs/[id].tsx')).toContain('sticky CTA:');
    expect(read('app/(app)/(tabs)/vendre.tsx')).toMatch(/sticky CTA: floating checkout card/);
  });
  it('touch targets: Button size lg stays >= 48dp', () => {
    expect(read('src/components/ui/Button.tsx')).toMatch(/lg:\s*\{[^}]*(minHeight|height):\s*(5\d|6\d)/);
  });
});
