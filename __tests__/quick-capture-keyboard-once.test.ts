// Opening "Vente rapide" drew the iOS keyboard twice (a ghost above the real one):
// the price field's autoFocus fired while the full-screen Modal was still animating
// in. The price is now focused from the Modal's onShow. No JSX transform exists in
// this jest setup, so the wiring is guarded at the source level.
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');
const vente = read('src/components/VenteRapideCapture.tsx');
const credit = read('src/components/CreditRapideCapture.tsx');
const sheet = read('src/components/QuickCaptureSheet.tsx');
const form = read('src/components/ui/FormSheet.tsx');
const code = (s: string) => s.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

describe('no autoFocus on the quick-capture fields', () => {
  it('the Vente price input has no autoFocus (comments may still mention it)', () => {
    expect(code(vente)).not.toMatch(/\bautoFocus\b/);
  });
  it('the Crédit first field never used autoFocus (nothing to change)', () => {
    expect(code(credit)).not.toMatch(/\bautoFocus\b/);
  });
});

describe('Vente exposes focusPrice() and the sheet calls it from onShow', () => {
  it('forwardRef + useImperativeHandle → focusPrice focuses the price input', () => {
    expect(vente).toMatch(/export const VenteRapideCapture = forwardRef<VenteRapideCaptureHandle, VenteRapideCaptureProps>/);
    expect(vente).toMatch(/useImperativeHandle\(ref, \(\) => \(\{ focusPrice: \(\) => priceRef\.current\?\.focus\(\) \}\), \[\]\)/);
    expect(vente).toMatch(/\n\}\);\n\nfunction makeStyles/);
  });
  it('FormSheet accepts onShow and passes it to the Modal', () => {
    expect(form).toMatch(/onShow\?: \(\) => void;/);
    expect(form).toMatch(/onRequestClose=\{onClose\}\s*onShow=\{onShow\}/);
  });
  it('QuickCaptureSheet focuses the price only after the modal has presented', () => {
    expect(sheet).toMatch(/onShow=\{\(\) => \{ presentedRef\.current = true; if \(mode === 'vente'\) venteRef\.current\?\.focusPrice\(\); \}\}/);
    expect(sheet).toMatch(/ref=\{venteRef\}/);
  });
  it('switching Crédit → Vente with the sheet already open still focuses (no animation to collide with)', () => {
    expect(sheet).toMatch(/if \(presentedRef\.current && mode === 'vente'\) venteRef\.current\?\.focusPrice\(\);/);
    expect(sheet).toMatch(/useEffect\(\(\) => \{ if \(!visible\) presentedRef\.current = false; \}, \[visible\]\);/);
  });
  it('the "Terminé" accessory wiring is untouched', () => {
    expect(vente).toMatch(/inputAccessoryViewID=\{Platform\.OS === 'ios' \? PRICE_ACCESSORY_ID : undefined\}/);
    expect(vente).toMatch(/<KeyboardDoneBar nativeID=\{PRICE_ACCESSORY_ID\} \/>/);
  });
});
