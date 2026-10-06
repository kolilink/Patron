// The Samsung "splash forever" bug (device video 2026-10-06). See src/utils/startupGate.ts.
// Hooks can't be rendered in this jest setup, so the decisions live in pure functions
// (tested here with fake timers) and the layout wiring is guarded at the source level.
import fs from 'fs';
import path from 'path';
import { SPLASH_CEILING_MS, scheduleSplashCeiling, startupReady } from '@/src/utils/startupGate';

const layout = fs.readFileSync(path.resolve(__dirname, '../app/_layout.tsx'), 'utf8');

describe('startupReady', () => {
  it('fonts loaded → ready', () => expect(startupReady(true, undefined, false)).toBe(true));
  it('useFonts = [false, Error] → ready (system font beats a permanent splash)', () => {
    expect(startupReady(false, new Error('font failed'), false)).toBe(true);
  });
  it('still loading, no error, ceiling not reached → not ready', () => expect(startupReady(false, undefined, false)).toBe(false));
  it('useFonts never settles → ready once the ceiling elapsed', () => expect(startupReady(false, undefined, true)).toBe(true));
});

describe('scheduleSplashCeiling — the splash always dismisses', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const arm = (ms?: number) => {
    const hide = jest.fn(); const onElapsed = jest.fn();
    const cancel = scheduleSplashCeiling({
      hide, onElapsed, ms,
      setTimeoutFn: (cb, t) => setTimeout(cb, t),
      clearTimeoutFn: h => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    return { hide, onElapsed, cancel };
  };

  it('with useFonts mocked to [false, Error] nothing else ever runs, yet hide is still called within the ceiling', () => {
    const { hide, onElapsed } = arm();
    // fonts failed and never loaded; auth/db never settle — only the ceiling is left
    jest.advanceTimersByTime(SPLASH_CEILING_MS - 1);
    expect(hide).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(hide).toHaveBeenCalledTimes(1);
    expect(onElapsed).toHaveBeenCalledTimes(1);
  });
  it('the ceiling is 5 seconds', () => expect(SPLASH_CEILING_MS).toBe(5000));
  it('cleanup cancels it', () => {
    const { hide, cancel } = arm();
    cancel();
    jest.advanceTimersByTime(SPLASH_CEILING_MS * 2);
    expect(hide).not.toHaveBeenCalled();
  });
});

describe('app/_layout.tsx wiring', () => {
  const code = layout.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  it('stops discarding the font error and reports it to Sentry (DSN-guarded)', () => {
    expect(layout).toMatch(/const \[fontsLoaded, fontError\] = useFonts\(ALL_FONTS\);/);
    expect(layout).toMatch(/if \(fontError && process\.env\.EXPO_PUBLIC_SENTRY_DSN\) \{\s*Sentry\.captureException\(fontError, \{ tags: \{ area: 'fonts' \} \}\);/);
  });
  it('the hard ceiling effect has NO dependency on fonts', () => {
    const m = layout.match(/useEffect\(\(\) => scheduleSplashCeiling\(\{[\s\S]*?\}\), \[\]\);/);
    expect(m).not.toBeNull();
    expect(m![0]).not.toMatch(/fontsLoaded|fontError/);
  });
  it('init proceeds on ready (loaded OR failed OR ceiling), no longer on fontsLoaded alone', () => {
    expect(layout).toMatch(/const ready = startupReady\(fontsLoaded, fontError, ceilingElapsed\);/);
    expect(layout).toMatch(/if \(!ready\) return;/);
    expect(layout).toMatch(/\}, \[ready\]\);/);
    expect(code).not.toMatch(/if \(!fontsLoaded\) return;/);
  });
  it('the existing 2s fast path and the first-paint hide are kept', () => {
    expect(layout).toMatch(/setTimeout\(\(\) => SplashScreen\.hideAsync\(\), 2000\)/);
    expect(layout).toMatch(/requestAnimationFrame\(\(\) => requestAnimationFrame\(\(\) => SplashScreen\.hideAsync\(\)\)\)/);
  });
});
