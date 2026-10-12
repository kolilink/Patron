// The Samsung "splash forever" bug (device video 2026-10-06). See src/utils/startupGate.ts.
// Hooks can't be rendered in this jest setup, so the decisions live in pure functions
// (tested here with fake timers) and the layout wiring is guarded at the source level.
import fs from 'fs';
import path from 'path';
import { FONT_WAIT_CEILING_MS, SPLASH_SAFETY_CEILING_MS, createSplashHider, scheduleFontCeiling, scheduleSplashCeiling, startupReady } from '@/src/utils/startupGate';

const layout = fs.readFileSync(path.resolve(__dirname, '../app/_layout.tsx'), 'utf8');

describe('startupReady', () => {
  it('fonts loaded → ready', () => expect(startupReady(true, undefined, false)).toBe(true));
  it('useFonts = [false, Error] → ready (system font beats a permanent splash)', () => {
    expect(startupReady(false, new Error('font failed'), false)).toBe(true);
  });
  it('still loading, no error, ceiling not reached → not ready', () => expect(startupReady(false, undefined, false)).toBe(false));
  it('useFonts never settles → ready once the ceiling elapsed', () => expect(startupReady(false, undefined, true)).toBe(true));
});

describe('the two ceilings are separate, and only one of them lifts the splash', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  const deps = (ms?: number) => ({ ms, setTimeoutFn: (cb: () => void, t: number) => setTimeout(cb, t), clearTimeoutFn: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) });

  it('constants: fonts wait at most 5s to unblock init; the splash safety ceiling is 8s', () => {
    expect(FONT_WAIT_CEILING_MS).toBe(5000);
    expect(SPLASH_SAFETY_CEILING_MS).toBe(8000);
  });
  it('the font ceiling lets startup proceed but NEVER lifts the splash', () => {
    const onElapsed = jest.fn();
    scheduleFontCeiling({ ...deps(), onElapsed });
    jest.advanceTimersByTime(FONT_WAIT_CEILING_MS - 1);
    expect(onElapsed).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(onElapsed).toHaveBeenCalledTimes(1);
  });
  it('with fonts/auth/db that never settle, the splash still lifts — at the 8s ceiling, not before', () => {
    const hide = jest.fn();
    scheduleSplashCeiling({ ...deps(), hide });
    jest.advanceTimersByTime(SPLASH_SAFETY_CEILING_MS - 1);
    expect(hide).not.toHaveBeenCalled();                                  // in particular NOT at 2s or 5s
    jest.advanceTimersByTime(1);
    expect(hide).toHaveBeenCalledTimes(1);
  });
  it('cleanup cancels both', () => {
    const hide = jest.fn(); const onElapsed = jest.fn();
    scheduleSplashCeiling({ ...deps(), hide })();
    scheduleFontCeiling({ ...deps(), onElapsed })();
    jest.advanceTimersByTime(SPLASH_SAFETY_CEILING_MS * 2);
    expect(hide).not.toHaveBeenCalled();
    expect(onElapsed).not.toHaveBeenCalled();
  });
});

describe('createSplashHider — the splash lifts at most once', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('init completing lifts it; the later safety ceiling is a no-op (native call made exactly once)', async () => {
    const hideAsync = jest.fn(() => Promise.resolve());
    const hider = createSplashHider(hideAsync);
    const ceiling = scheduleSplashCeiling({ hide: () => { hider.hide(); }, setTimeoutFn: (cb, t) => setTimeout(cb, t), clearTimeoutFn: h => clearTimeout(h as ReturnType<typeof setTimeout>) });
    jest.advanceTimersByTime(1500);                       // init completes around here on a normal phone
    expect(hider.hide()).toBe(true);
    expect(hideAsync).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(SPLASH_SAFETY_CEILING_MS);   // the ceiling fires later…
    expect(hideAsync).toHaveBeenCalledTimes(1);           // …and does nothing
    expect(hider.hidden).toBe(true);
    ceiling();
  });
  it('init that never completes: the ceiling lifts it, and a LATE init completion does not lift it twice', () => {
    const hideAsync = jest.fn(() => Promise.resolve());
    const hider = createSplashHider(hideAsync);
    scheduleSplashCeiling({ hide: () => { hider.hide(); }, setTimeoutFn: (cb, t) => setTimeout(cb, t), clearTimeoutFn: h => clearTimeout(h as ReturnType<typeof setTimeout>) });
    jest.advanceTimersByTime(SPLASH_SAFETY_CEILING_MS);
    expect(hideAsync).toHaveBeenCalledTimes(1);
    expect(hider.hide()).toBe(false);                     // init finally completes at 12s
    expect(hideAsync).toHaveBeenCalledTimes(1);
  });
  it('a rejecting or throwing hideAsync (already hidden) never surfaces', async () => {
    expect(() => createSplashHider(() => Promise.reject(new Error('already hidden'))).hide()).not.toThrow();
    expect(() => createSplashHider(() => { throw new Error('sync'); }).hide()).not.toThrow();
    await Promise.resolve();
  });
});

describe('app/_layout.tsx wiring', () => {
  const code = layout.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  it('stops discarding the font error and reports it to Sentry (DSN-guarded)', () => {
    expect(layout).toMatch(/const \[fontsLoaded, fontError\] = useFonts\(ALL_FONTS\);/);
    expect(layout).toMatch(/if \(fontError && process\.env\.EXPO_PUBLIC_SENTRY_DSN\) \{\s*Sentry\.captureException\(fontError, \{ tags: \{ area: 'fonts' \} \}\);/);
  });
  it('both ceiling effects have NO dependency on fonts', () => {
    for (const fn of ['scheduleFontCeiling', 'scheduleSplashCeiling']) {
      const m = layout.match(new RegExp(`useEffect\\(\\(\\) => ${fn}\\(\\{[\\s\\S]*?\\}\\), \\[\\]\\);`));
      expect(m).not.toBeNull();
      expect(m![0]).not.toMatch(/fontsLoaded|fontError/);
    }
  });
  it('init proceeds on ready (loaded OR failed OR ceiling), no longer on fontsLoaded alone', () => {
    expect(layout).toMatch(/const ready = startupReady\(fontsLoaded, fontError, ceilingElapsed\);/);
    expect(layout).toMatch(/if \(!ready\) return;/);
    expect(layout).toMatch(/\}, \[ready\]\);/);
    expect(code).not.toMatch(/if \(!fontsLoaded\) return;/);
  });
  it('the hard 2s hide is gone: the splash lifts when init completes (after two painted frames), once', () => {
    expect(code).not.toMatch(/setTimeout\(\(\) => SplashScreen\.hideAsync\(\), 2000\)/);
    expect(code).not.toMatch(/\b2000\b/);
    expect(layout).toMatch(/requestAnimationFrame\(\(\) => requestAnimationFrame\(\(\) => \{ splash\.hide\(\); \}\)\)/);
    // no other direct hideAsync call can bypass the once-guard
    expect((code.match(/hideAsync\(/g) || []).length).toBe(1);
    expect(layout).toContain('createSplashHider(() => SplashScreen.hideAsync())');
  });
  it('never a blank frame while loading: the loading branches render the themed fill', () => {
    const appLayout = fs.readFileSync(path.resolve(__dirname, '../app/(app)/_layout.tsx'), 'utf8');
    expect(appLayout).toContain('if (loading) return <><ThemedFill />{heroOverlay}</>;');
    expect(appLayout).not.toMatch(/if \(loading\) return <>\{heroOverlay\}<\/>;/);
    expect(fs.readFileSync(path.resolve(__dirname, '../app/index.tsx'), 'utf8')).toContain('return <ThemedFill />;');
    const themed = fs.readFileSync(path.resolve(__dirname, '../src/components/ui/ThemedStack.tsx'), 'utf8');
    expect(themed).toMatch(/export function ThemedFill\(\) \{[\s\S]*?backgroundColor: palette\.background/);
  });
});
