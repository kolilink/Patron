// Quick-capture sheet bugs seen on device video (2026-10-06). No JSX transform
// exists in this jest setup, so the fixes are guarded at the source level.
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');

describe('zombie keyboard after a sheet closes', () => {
  const src = read('src/components/ui/FormSheet.tsx');
  it('FormSheet dismisses the keyboard whenever it becomes hidden', () => {
    expect(src).toMatch(/import React, \{[^}]*\buseEffect\b[^}]*\} from 'react'/);
    expect(src).toMatch(/^\s*Keyboard,$/m);
    expect(src).toMatch(/useEffect\(\(\) => \{\s*if \(!visible\) Keyboard\.dismiss\(\);\s*\}, \[visible\]\);/);
  });
  it('the effect sits above the Modal render, so no early return can skip it (rules of hooks)', () => {
    expect(src.indexOf('Keyboard.dismiss()')).toBeLessThan(src.indexOf('<Modal'));
  });
});

describe('no "Crédit rapide" flash when opening on Vente', () => {
  const src = read('src/components/QuickCaptureSheet.tsx');
  it('the mode/tally reset is a layout effect (applies before first paint)', () => {
    expect(src).toMatch(/import \{[^}]*\buseLayoutEffect\b[^}]*\} from 'react'/);
    expect(src).toMatch(/useLayoutEffect\(\(\) => \{\s*if \(!visible\) return;\s*setMode\(initialMode\);[\s\S]*?\}, \[visible, initialMode\]\);/);
  });
  it('no passive effect still resets mode', () => {
    expect(src).not.toMatch(/useEffect\(\(\) => \{\s*if \(!visible\) return;\s*setMode\(initialMode\)/);
  });
});

describe('"Terminé" only dismisses the keyboard', () => {
  const bar = read('src/components/ui/KeyboardDoneBar.tsx');
  it('the bar takes no close handler and never touches the sheet', () => {
    expect(bar).toMatch(/KeyboardDoneBar\(\{ nativeID \}: \{ nativeID: string \}\)/);
    expect(bar).toMatch(/Keyboard\.dismiss\(\)/);
    expect(bar).not.toMatch(/onClose|router\.|setVisible|closeSheet/);
  });
});
