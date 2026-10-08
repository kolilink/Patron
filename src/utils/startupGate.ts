// Startup must never hang on a font. Device video 2026-10-06 (Samsung, Android): the
// purple splash stayed forever — no crash, it just never proceeded. app/_layout.tsx
// read `const [fontsLoaded] = useFonts(...)` (the error was discarded) and EVERYTHING
// — including the 2s splash-hide fallback, and auth/db init — lived inside an effect
// gated on `fontsLoaded`. One font failing to load (a bad bundled asset, an old-Android
// quirk) left fontsLoaded false forever: the fallback was never even scheduled and
// preventAutoHideAsync() held the splash permanently. Structural, not device-specific.

/** Longest the splash may ever stay up, whatever fonts/auth/db do. */
export const SPLASH_CEILING_MS = 8000;

/** Wraps hideAsync so it runs exactly once, whichever of init-complete / ceiling gets there first. */
export function createSplashHider(hide: () => unknown): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    try {
      const r = hide();
      if (r && typeof (r as Promise<unknown>).catch === 'function') (r as Promise<unknown>).catch(() => { /* already hidden */ });
    } catch { /* already hidden */ }
  };
}

/**
 * May startup (auth + SQLite init) proceed? Yes once fonts loaded, once they FAILED
 * (the system font stands in for the custom one — far better than a dead app), or once
 * the ceiling elapsed because useFonts never settled either way.
 */
export function startupReady(fontsLoaded: boolean, fontError: unknown, ceilingElapsed: boolean): boolean {
  return fontsLoaded || !!fontError || ceilingElapsed;
}

export interface SplashCeilingDeps {
  /** SplashScreen.hideAsync — idempotent, safe to call after the normal path already hid it. */
  hide: () => void;
  /** Called when the ceiling elapses (lets startup proceed even if useFonts never settled). */
  onElapsed: () => void;
  setTimeoutFn: (cb: () => void, ms: number) => unknown;
  clearTimeoutFn: (h: unknown) => void;
  ms?: number;
}

/** Arms the ungated hard ceiling. Returns a canceller for the effect's cleanup. */
export function scheduleSplashCeiling(d: SplashCeilingDeps): () => void {
  const timer = d.setTimeoutFn(() => { d.hide(); d.onElapsed(); }, d.ms ?? SPLASH_CEILING_MS);
  return () => d.clearTimeoutFn(timer);
}
