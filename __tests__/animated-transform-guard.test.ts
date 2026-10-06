// FATAL Android crash on every 1.0.9 (101) install (Sentry REACT-NATIVE-B):
//   UnexpectedNativeTypeException: Value for scale cannot be cast from ReadableNativeMap to double
// Cause: Button.tsx applied `transform: [{ scale }]` — `scale` an Animated.Value — to a PLAIN
// Pressable. React Native guards that only with a __DEV__ invariant (processTransform.js:
// "You passed an Animated.Value to a normal component"); in a release build the
// Animated.Value object reaches native as a map and Android's TransformHelper calls
// ReadableNativeMap.getDouble("scale"). iOS parses the same prop leniently, so only Android died.
//
// This guard fails the build if a transform entry takes a non-literal value on anything that
// is not an Animated component / a Reanimated worklet style.
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
  const p = path.join(d, e.name);
  return e.isDirectory() ? walk(p) : /\.tsx$/.test(e.name) ? [p] : [];
});

// transform entries like { scale: x } / { translateX: foo } whose value is not a numeric literal / arithmetic of literals
const ENTRY = /\{\s*(scale|scaleX|scaleY|translateX|translateY|rotate|rotateX|rotateY|rotateZ)\s*(?::\s*([^}]+))?\}/g;
// a literal: numbers/arithmetic ({ scale: 0.97 }) or a quoted string ({ rotate: '-45deg' })
const isPlainNumber = (v: string | undefined) => v !== undefined && (/^[\s\d.+\-*/()]+$/.test(v) || /^\s*['"][^'"]*['"]\s*,?\s*$/.test(v));
const ANIMATED_CONTEXT = /<(RN)?Animated\.(View|Text|Image|ScrollView|FlatList)|createAnimatedComponent|useAnimatedStyle\(|Animated\.Value|interpolate\(/;

export function findViolations(): string[] {
  const out: string[] = [];
  for (const dir of ['app', 'src']) for (const file of walk(path.join(ROOT, dir))) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/transform\s*:\s*\[/.test(line)) return;
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*')) return;
      for (const m of line.matchAll(ENTRY)) {
        const value = m[2];                       // undefined for shorthand `{ scale }`
        if (isPlainNumber(value)) continue;       // { scale: 0.97 }
        // a non-literal animated value: only OK on an Animated component or inside a worklet style
        const context = lines.slice(Math.max(0, i - 8), i + 1).join('\n');
        if (!ANIMATED_CONTEXT.test(context)) out.push(`${path.relative(ROOT, file)}:${i + 1}: ${t}`);
      }
    });
  }
  return out;
}

describe('no animated transform value on a non-Animated component', () => {
  it('Button no longer puts an Animated.Value on its plain Pressable', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/components/ui/Button.tsx'), 'utf8');
    const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/transform\s*:/);
    expect(code).not.toMatch(/Animated\.Value|\bAnimated\b/);
    expect(code).toMatch(/onPressIn=\{onPressIn\}/);   // callers' handlers still pass straight through
    expect(code).toMatch(/pressed \? styles\.pressed : null/);  // press feedback is the style, not a transform
  });
  it('the whole app has no other offender (the scan itself finds nothing)', () => {
    expect(findViolations()).toEqual([]);
  });
  it('the scan bites: the pre-fix Button line would have been flagged', () => {
    const pre = '    { transform: [{ scale }] },';
    const entries = [...pre.matchAll(ENTRY)];
    expect(entries.length).toBe(1);
    expect(isPlainNumber(entries[0][2])).toBe(false);
    expect(ANIMATED_CONTEXT.test('const getStyle = ({ pressed }) => [\n styles.base,\n' + pre)).toBe(false);
  });
});
