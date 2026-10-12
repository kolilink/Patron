// Startup must never hang on a font. Device video 2026-10-06 (Samsung, Android): the
// purple splash stayed forever — no crash, it just never proceeded. app/_layout.tsx
// read `const [fontsLoaded] = useFonts(...)` (the error was discarded) and EVERYTHING
// — including the 2s splash-hide fallback, and auth/db init — lived inside an effect
// gated on `fontsLoaded`. One font failing to load (a bad bundled asset, an old-Android
// quirk) left fontsLoaded false forever: the fallback was never even scheduled and
// preventAutoHideAsync() held the splash permanently. Structural, not device-specific.

/**
 * Longest startup waits for FONTS to settle before it carries on with the system font. This only unblocks
 * init (auth + SQLite); it does NOT lift the splash.
 */
export const FONT_WAIT_CEILING_MS = 5000;

/**
 * Longest the splash may ever stay up. The splash normally lifts when init COMPLETES (plus two painted
 * frames); this is only the safety net for an init that never settles. It used to be a hard 2s timeout that
 * lifted the splash onto a half-initialised app — on a slow phone that is a blank screen.
 */
export const SPLASH_SAFETY_CEILING_MS = 8000;

/**
 * May startup (auth + SQLite init) proceed? Yes once fonts loaded, once they FAILED
 * (the system font stands in for the custom one — far better than a dead app), or once
 * the font-wait ceiling elapsed because useFonts never settled either way.
 */
export function startupReady(fontsLoaded: boolean, fontError: unknown, ceilingElapsed: boolean): boolean {
  return fontsLoaded || !!fontError || ceilingElapsed;
}

/**
 * Lifts the splash AT MOST ONCE, whoever asks first (init completing, or the safety ceiling). The native
 * call is never repeated, and a rejected hide (already hidden) is swallowed.
 */
export function createSplashHider(hideAsync: () => Promise<unknown> | void): { hide: () => boolean; readonly hidden: boolean } {
  let hidden = false;
  return {
    hide() {
      if (hidden) return false;
      hidden = true;
      try { void Promise.resolve(hideAsync()).catch(() => { /* already hidden */ }); } catch { /* already hidden */ }
      return true;
    },
    get hidden() { return hidden; },
  };
}

export interface CeilingDeps {
  setTimeoutFn: (cb: () => void, ms: number) => unknown;
  clearTimeoutFn: (h: unknown) => void;
  ms?: number;
}

/** Arms the ungated font-wait ceiling (lets startup proceed even if useFonts never settled). Returns a canceller. */
export function scheduleFontCeiling(d: CeilingDeps & { onElapsed: () => void }): () => void {
  const timer = d.setTimeoutFn(() => d.onElapsed(), d.ms ?? FONT_WAIT_CEILING_MS);
  return () => d.clearTimeoutFn(timer);
}

/** Arms the splash safety ceiling: `hide` (the once-guarded hider) runs if init never completes. Returns a canceller. */
export function scheduleSplashCeiling(d: CeilingDeps & { hide: () => void }): () => void {
  const timer = d.setTimeoutFn(() => d.hide(), d.ms ?? SPLASH_SAFETY_CEILING_MS);
  return () => d.clearTimeoutFn(timer);
}
