// Perceived-performance pass: no decorative perpetual motion, and the splash
// lifts exactly once — after init, or at the 8s ceiling — never before.
import fs from 'fs';
import path from 'path';
import { SPLASH_CEILING_MS, createSplashHider, scheduleSplashCeiling } from '@/src/utils/startupGate';
import { showUnsavedDot } from '@/src/utils/unsavedDot';

const read = (f: string) => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');
const code = (f: string) => read(f).split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

describe('(a) splash waits for init, with one hide and an 8s safety', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const arm = () => {
    const hideAsync = jest.fn().mockResolvedValue(undefined);
    const hide = createSplashHider(hideAsync);
    scheduleSplashCeiling({
      hide, onElapsed: () => {},
      setTimeoutFn: (cb, ms) => setTimeout(cb, ms),
      clearTimeoutFn: h => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    return { hideAsync, hide };
  };

  it('init resolves → hidden once (and the later ceiling does not hide again)', async () => {
    const { hideAsync, hide } = arm();
    let resolveInit!: () => void;
    const init = new Promise<void>(r => { resolveInit = r; });
    init.then(() => hide());
    jest.advanceTimersByTime(2500);             // the OLD fixed timeout would have fired here
    expect(hideAsync).not.toHaveBeenCalled();
    resolveInit();
    await Promise.resolve(); await Promise.resolve();
    expect(hideAsync).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(SPLASH_CEILING_MS * 2);
    expect(hideAsync).toHaveBeenCalledTimes(1);
  });

  it('init hangs → the 8s safety hides it, once', () => {
    const { hideAsync, hide } = arm();
    jest.advanceTimersByTime(SPLASH_CEILING_MS - 1);
    expect(hideAsync).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(hideAsync).toHaveBeenCalledTimes(1);
    hide(); hide();                              // a late init completion
    expect(hideAsync).toHaveBeenCalledTimes(1);
  });

  it('a throwing / rejecting hideAsync never escapes', async () => {
    expect(() => createSplashHider(() => { throw new Error('x'); })()).not.toThrow();
    createSplashHider(() => Promise.reject(new Error('x')))();
    await Promise.resolve();
  });

  it('root layout: no fixed 2s timeout, every hide goes through the once-guard, and it lifts after init', () => {
    const src = code('app/_layout.tsx');
    expect(src).not.toMatch(/,\s*2000\)/);
    expect(src.match(/hideAsync\(/g)?.length).toBe(1);               // only inside createSplashHider(...)
    expect(src).toMatch(/createSplashHider\(\(\) => SplashScreen\.hideAsync\(\)\)/);
    expect(src).toMatch(/\.finally\(\(\) => \{[\s\S]*hideSplashOnce\(\)/);
    expect(src).toMatch(/hide: hideSplashOnce/);
  });

  it('(app) layout renders a theme-coloured view, not null, while loading', () => {
    expect(code('app/(app)/_layout.tsx')).toMatch(/if \(loading\) return <><View style=\{\{ flex: 1, backgroundColor: themePalette\.background \}\} \/>/);
    expect(code('app/(app)/_layout.tsx')).not.toMatch(/if \(loading\) return null/);
  });
});

describe('(b) no breathing loops where decoration lived; legitimate pulses kept', () => {
  const removed = [
    'app/(app)/(tabs)/catalogue.tsx',
    'app/(app)/(tabs)/vendre.tsx',
    'app/(app)/depenses/index.tsx',
    'app/(app)/fournisseurs/index.tsx',
    'app/(app)/parametres/index.tsx',
  ];
  for (const f of removed) {
    it(`${f} has no Animated.loop`, () => expect(code(f)).not.toMatch(/Animated\.loop\(/));
  }
  const kept = ['app/(app)/messages/[room_id].tsx', 'app/(app)/alpha/index.tsx', 'app/(app)/equipe/index.tsx'];
  for (const f of kept) {
    it(`${f} keeps its pulse`, () => expect(code(f)).toMatch(/Animated\.loop\(/));
  }
});

describe('(c) Paramètres header: steady button, static unsaved dot', () => {
  it('dot iff dirty and not saving', () => {
    expect(showUnsavedDot(true, false)).toBe(true);
    expect(showUnsavedDot(true, true)).toBe(false);
    expect(showUnsavedDot(false, false)).toBe(false);
    expect(showUnsavedDot(false, true)).toBe(false);
  });
  it('the header renders it from that predicate, in a plain View, with house copy and colors', () => {
    const src = code('app/(app)/parametres/index.tsx');
    expect(src).toMatch(/showUnsavedDot\(isDirty, saving\)/);
    expect(src).toMatch(/testID="unsaved-dot"[^>]*backgroundColor: palette\.warning/);
    expect(src).toMatch(/saving \? 'Enreg…' : 'Enregistrer'/);
    expect(src).toMatch(/color: isDirty \? palette\.primary : palette\.textDisabled/);
    expect(src).not.toMatch(/breathAnim|loopRef/);
  });
});
