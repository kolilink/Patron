// GestureSheet physics (2026-10-16): the sheet animated like the old drawer —
// fixed 300/240/200 ms timings, and a drag release checked the velocity only
// as a threshold before throwing it away, so a hard fling and a gentle
// release fell identically. Every settle is now a spring on the shared
// physical pair (stiffness 320, damping 34, ζ ≈ 0.95), inheriting the
// finger's velocity where a gesture exists. The decision maths in
// sheetGesture.ts (shouldDismiss thresholds) is untouched.
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');

describe('GestureSheet — spring physics wiring (source contracts)', () => {
  const g = read('src/components/ui/GestureSheet.tsx');

  it('has no fixed-duration timing left: every settle is a spring', () => {
    expect(g).not.toContain('withTiming');
    expect(g).not.toContain('Easing');
    expect(g).toContain('withSpring');
  });

  it('open is a velocity-less spring off the shared pair', () => {
    expect(g).toMatch(/withSpring\(0, \{ \.\.\.SHEET_SPRING, velocity: 0 \}\)/);
  });

  it('programmatic close (requestClose, parent close) is a velocity-less spring', () => {
    expect(g).toMatch(/withSpring\(screenH, \{ \.\.\.SHEET_SPRING, velocity: 0 \}/);
  });

  it('drag-release dismiss inherits the finger velocity — no more canned 200 ms fall', () => {
    expect(g).toMatch(/withSpring\(screenH, \{ \.\.\.SHEET_SPRING, velocity: e\.velocityY \}/);
    expect(g).not.toContain('duration: 200');
  });

  it('spring-back also inherits the release velocity (it used to get none)', () => {
    expect(g).toMatch(/withSpring\(0, \{ \.\.\.SHEET_SPRING, velocity: e\.velocityY \}\)/);
  });

  it('the spring pair is the shared physical language: stiffness 320, damping 34 (ζ ≈ 0.95)', () => {
    expect(g).toMatch(/const SHEET_SPRING = \{ stiffness: 320, damping: 34 \}/);
    expect(g).toContain('ζ ≈ 0.95');
  });

  it('reduce-motion paths stay instant, with no spring', () => {
    expect(g).toContain('if (reduce) translateY.value = 0;');
    expect(g).toMatch(/if \(reduce\) \{\s+translateY\.value = screenH;\s+setRendered\(false\);\s+\}/);
  });

  it('the release decision rule is unchanged (thresholds live in sheetGesture.ts)', () => {
    expect(g).toMatch(/e\.velocityY >= DISMISS_VELOCITY \|\| translateY\.value >= h \* DISMISS_FRACTION/);
  });

  it('props, Modal, and the finish plumbing are unchanged', () => {
    expect(g).toContain('<Modal');
    expect(g).toContain('onClose: () => void');
    expect(g).toContain('runOnJS(finishClose)()');
    expect(g).toContain('Gesture.Pan()');
    expect(g).toContain('statusBarTranslucent');
  });
});
