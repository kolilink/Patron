// Fix B: the two quick-capture screens must carry a real "Terminé" accessory,
// not the empty zero-height placeholder. There is no JSX transform in this
// jest setup (no component tests anywhere), so this guards the wiring at the
// source level: the shared component, its 44pt height and dismiss action, and
// that both screens use it with their existing accessory ids.
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');

describe('KeyboardDoneBar', () => {
  const bar = read('src/components/ui/KeyboardDoneBar.tsx');
  it('is a 44pt bar with a right-aligned "Terminé" that dismisses the keyboard', () => {
    expect(bar).toMatch(/KEYBOARD_DONE_BAR_HEIGHT = 44/);
    expect(bar).toMatch(/justifyContent: 'flex-end'/);
    expect(bar).toMatch(/Keyboard\.dismiss\(\)/);
    expect(bar).toMatch(/Terminé/);
    expect(bar).toMatch(/color="primary"/);
    expect(bar).toMatch(/backgroundColor: p\.surface/);
  });
  it('renders nothing off iOS', () => {
    expect(bar).toMatch(/Platform\.OS !== 'ios'\) return null/);
  });
});

describe.each([
  ['src/components/CreditRapideCapture.tsx', 'AMOUNT_ACCESSORY_ID'],
  ['src/components/VenteRapideCapture.tsx', 'PRICE_ACCESSORY_ID'],
])('%s', (file, id) => {
  const src = read(file);
  it('keeps its inputAccessoryViewID wiring and renders the real bar for it', () => {
    expect(src).toMatch(new RegExp(`inputAccessoryViewID=\\{Platform\\.OS === 'ios' \\? ${id} : undefined\\}`));
    expect(src).toMatch(new RegExp(`<KeyboardDoneBar nativeID=\\{${id}\\} />`));
  });
  it('no longer has the empty zero-height placeholder', () => {
    expect(src).not.toMatch(/<InputAccessoryView/);
    expect(src).not.toMatch(/height: 0 \}\} \/>/);
  });
});
