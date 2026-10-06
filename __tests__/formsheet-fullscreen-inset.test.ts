// Full-screen FormSheet (Crédit/Vente rapide) on iOS drew its header under the status
// bar on first open: the Modal's own SafeAreaView reports a 0 top inset until a later
// layout. The fix takes the inset from the ROOT provider. No JSX transform exists in
// this jest setup, so the wiring is guarded at the source level.
import fs from 'fs';
import path from 'path';

const src = fs.readFileSync(path.resolve(__dirname, '../src/components/ui/FormSheet.tsx'), 'utf8');

describe('FormSheet fullScreen top inset', () => {
  it('reads the root safe-area insets, not only the Modal\'s own SafeAreaView', () => {
    expect(src).toMatch(/import \{ SafeAreaView, useSafeAreaInsets, type Edge \}/);
    expect(src).toMatch(/const rootInsets = useSafeAreaInsets\(\);/);
  });
  it('applies the inset explicitly for iOS fullScreen only', () => {
    expect(src).toMatch(/Platform\.OS === 'ios' && presentationStyle === 'fullScreen' \? rootInsets\.top : 0/);
    expect(src).toMatch(/explicitTopInset > 0 && \{ paddingTop: explicitTopInset \}/);
  });
  it('does not double-count: with the explicit padding the native view only handles the bottom', () => {
    expect(src).toMatch(/explicitTopInset > 0\s*\? \['bottom'\]/);
  });
  it('Android and non-fullScreen behaviour is unchanged', () => {
    expect(src).toMatch(/needsTopInset \? \['top', 'bottom'\] : \['bottom'\]/);
    expect(src).toMatch(/const needsTopInset = Platform\.OS === 'android' \|\| presentationStyle === 'fullScreen';/);
  });
  it('the hook runs unconditionally above the Modal (rules of hooks)', () => {
    expect(src.indexOf('useSafeAreaInsets()')).toBeLessThan(src.indexOf('<Modal'));
  });
});
