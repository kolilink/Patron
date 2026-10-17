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

// ─── The launch sequence, with every stage bounded ────────────────────────────
// openDb() (SQLite.openDatabaseAsync + migrations) can hang forever — neither
// resolving nor rejecting — on a corrupt DB or a sick device. The launch effect
// awaited Promise.all([initialize(), openDb()]) with no bound, so the whole
// .then() chain behind it (invite-token capture, install record, app_opened,
// funnel flush) never ran, and neither did .finally (the freshSessionToken bump).
// The splash still hid via its own ceiling, but the app ran the entire session
// with a dead offline layer and no startup telemetry. Same philosophy as the
// reject-clearing in lib/db.ts: a hung open must not wedge the session.

/** Longest any one startup stage may take before the sequence moves on. */
export const STARTUP_STAGE_TIMEOUT_MS = 8000;

export const TIMED_OUT = Symbol('startup-stage-timed-out');

/** Resolves with `work`'s result, or with TIMED_OUT (after calling onTimeout) if it takes longer than `ms`. */
export function raceStartup<T>(work: Promise<T>, ms: number, onTimeout: () => void): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { onTimeout(); resolve(TIMED_OUT); }, ms);
    work.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
}

export interface StartupDeps {
  initialize: () => Promise<unknown>;
  openDb: () => Promise<unknown>;
  /** Forget the cached DB promise so a later openDb() retries fresh (lib/db.ts resetDbPromise). */
  resetDb: () => void;
  /** Report a stage timeout (Sentry). */
  reportTimeout: (stage: 'db_open' | 'post_open') => void;
  /** Everything that needs the KV store: invite-token capture, install record, app_opened, funnel flush. */
  postOpenSteps: () => Promise<unknown>;
  /** The old `.finally`: hide-splash scheduling and the freshSessionToken bump. Always runs. */
  onDone: () => void;
  timeoutMs?: number;
}

/**
 * auth init + SQLite open (bounded) → the KV-dependent steps (bounded) → onDone.
 * On a stage timeout it reports, (for the open) resets the cached DB promise, and
 * CONTINUES: the chain always reaches onDone.
 */
export async function runStartupSequence(d: StartupDeps): Promise<void> {
  const ms = d.timeoutMs ?? STARTUP_STAGE_TIMEOUT_MS;
  try {
    await raceStartup(Promise.all([d.initialize(), d.openDb()]), ms, () => {
      d.reportTimeout('db_open');
      d.resetDb();
    });
    await raceStartup(d.postOpenSteps(), ms, () => d.reportTimeout('post_open'));
  } catch {
    /* non-fatal — same as before: a failing stage never blocks startup */
  } finally {
    d.onDone();
  }
}
