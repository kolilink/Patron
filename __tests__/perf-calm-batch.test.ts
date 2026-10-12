// Perceived-performance batch: calm FABs, steady Paramètres save button. (The splash gate is covered in
// startup-gate.test.ts.) Pure rules are tested for real; the rendering is pinned at source level because this
// repo has no component-render harness.

import fs from 'fs';
import path from 'path';
import { saveButtonLabel, showUnsavedDot } from '@/src/utils/saveButton';

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');
const code = (s: string) => s.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

describe('Part 1 — no infinite animation loop on any FAB screen', () => {
  const FAB_FILES = [
    'app/(app)/depenses/index.tsx',
    'app/(app)/fournisseurs/index.tsx',
    'app/(app)/(tabs)/vendre.tsx',
    'src/components/products/ProductManager.tsx',   // the former catalogue FAB lives here now
  ];
  it.each(FAB_FILES)('%s: no loop, no repeat, no breathing scale/opacity', (file) => {
    const src = code(read(file));
    expect(src).not.toMatch(/Animated\.loop|withRepeat|iterations: -1/);
    expect(src).not.toMatch(/fabScale|fabOpacity|fabReduceMotion|toValue: 1\.06|toValue: 0\.85/);
  });
  it('the dépenses FAB is a plain View (it was the last one still breathing)', () => {
    const src = read('app/(app)/depenses/index.tsx');
    expect(src).toMatch(/<View style=\{\[styles\.fabContainer, /);
    expect(src).not.toMatch(/<Animated\.View style=\{\[styles\.fabContainer/);
    expect(src).not.toMatch(/\bAnimated\b/);
  });
  it('the old catalogue screen (a former offender) no longer exists', () => {
    expect(fs.existsSync(path.resolve(__dirname, '../app/(app)/(tabs)/catalogue.tsx'))).toBe(false);
  });
  it('animations that carry MEANING are untouched: voice-recording pulse dots (the équipe CTA pulse was a decorative loop and is gone)', () => {
    expect(read('app/(app)/discussions.tsx')).toMatch(/RNAnimated\.loop\(/);
    expect(read('app/(app)/messages/[room_id].tsx')).toMatch(/RNAnimated\.loop\(/);
    expect(read('app/(app)/equipe/index.tsx')).not.toMatch(/Animated\.loop\(/);
  });
  it('loading skeleton shimmers are not FABs and are left alone', () => {
    expect(read('app/(app)/ventes/index.tsx')).toMatch(/function SkeletonLine/);
  });
});

describe('Part 3 — Paramètres "Enregistrer" is completely steady', () => {
  const src = read('app/(app)/parametres/index.tsx');
  const header = src.slice(src.indexOf('<View style={styles.hdr}>'), src.indexOf('<KeyboardAvoidingView'));

  it('the dot shows only when dirty and not saving', () => {
    expect(showUnsavedDot(true, false)).toBe(true);     // unsaved changes → dot
    expect(showUnsavedDot(true, true)).toBe(false);     // saving → dot gone
    expect(showUnsavedDot(false, false)).toBe(false);   // clean → no dot
    expect(showUnsavedDot(false, true)).toBe(false);
  });
  it('copy is unchanged: "Enreg…" while saving, "Enregistrer" otherwise', () => {
    expect(saveButtonLabel(true)).toBe('Enreg…');
    expect(saveButtonLabel(false)).toBe('Enregistrer');
  });
  it('renders ZERO animation in the header: no Animated, no loop, no timing/spring/driver', () => {
    expect(code(header)).not.toMatch(/Animated|useNativeDriver|\.loop\(|withTiming|withSpring|withRepeat|breathAnim|opacity:/);
    expect(src).not.toMatch(/breathAnim|loopRef|Animated\.loop|from 'react-native-reanimated'/);
    expect(src).not.toMatch(/\bAnimated\b/);
  });
  it('the amber dot is a static View placed immediately before the text, using the warning (amber) token', () => {
    const dot = header.indexOf('styles.saveDot');
    const text = header.indexOf('saveButtonLabel(saving)');
    expect(dot).toBeGreaterThan(-1);
    expect(text).toBeGreaterThan(dot);
    expect(header).toContain('showUnsavedDot(isDirty, saving) &&');
    expect(header).toContain('backgroundColor: palette.warning');
    expect(src).toMatch(/saveDot: \{ width: 6, height: 6, borderRadius: 3 \}/);
  });
  it('colour logic is untouched: purple (palette.primary) when dirty, textDisabled when clean; still disabled when saving or clean', () => {
    expect(header).toContain('color: isDirty ? palette.primary : palette.textDisabled');
    expect(header).toContain('disabled={saving || !isDirty}');
    expect(header).toContain('onPress={saveAll}');
  });
});
