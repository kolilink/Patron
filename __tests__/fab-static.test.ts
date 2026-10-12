// The "Livraison" (Fournisseurs) floating buttons used to
// "breathe" (a 4-second scale + opacity loop). They now just sit there.
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');
const code = (s: string) => s.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

describe.each([
  ['app/(app)/fournisseurs/index.tsx', 'Livraison'],
  ['app/(app)/depenses/index.tsx', 'Dépense'],
])('%s', (file, label) => {
  const src = code(read(file));
  it('has no breathing animation state or loop for the FAB', () => {
    expect(src).not.toMatch(/fabScale|fabOpacity|fabReduceMotion/);
    expect(src).not.toMatch(/toValue: 1\.06/);
  });
  it(`the "${label}" button is a plain View with no animated transform`, () => {
    expect(src).toMatch(/<View style=\{\[styles\.fabContainer, /);
    expect(src).not.toMatch(/<Animated\.View style=\{\[styles\.fabContainer/);
  });
  it('the button itself and its position are unchanged', () => {
    expect(src).toMatch(new RegExp(`<Text style=\\{styles\\.fabExtendedLabel\\}>${label}</Text>`));
    expect(src).toMatch(/fabContainer: \{ position: 'absolute'/);
  });
});

describe("Gérer mode's floating +", () => {
  const src = code(read('src/components/products/ProductManager.tsx'));
  it('is a plain View + Pressable: no breathing animation, no animated transform', () => {
    expect(src).not.toMatch(/fabScale|fabOpacity|fabReduceMotion|toValue: 1\.06/);
    expect(src).toMatch(/<View style=\{\[styles\.fabContainer, /);
    expect(src).toMatch(/fabContainer: \{ position: 'absolute'/);
  });
});
