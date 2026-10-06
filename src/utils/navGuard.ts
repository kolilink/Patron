// Welcome-stack navigation guards (device video 2026-10-06: tapping "Se connecter"
// froze the push transition halfway — the welcome screen stayed composited over
// "Connexion" and the iOS keypad drew doubled).
//
// Cause: the welcome screens run an effect on `session` that calls router.replace()
// the moment a session exists — while the tap's router.push (slide_from_right) was
// still animating. A replace landing mid-push freezes the native transition with
// both screens in the tree. Two small pieces, kept pure so they're unit-testable:

/** Drops a second tap that arrives inside `windowMs` of the last accepted one. */
export function createTapGuard(windowMs = 900, now: () => number = Date.now) {
  let last = -Infinity;
  return {
    /** true = go ahead (and the window starts); false = a double-tap, ignore it. */
    allow(): boolean {
      const t = now();
      if (t - last < windowMs) return false;
      last = t;
      return true;
    },
  };
}

export interface SessionRedirectDeps {
  /** The redirect itself. Called at most once. */
  run: () => void;
  runAfterInteractions: (cb: () => void) => { cancel: () => void };
  setTimeoutFn: (cb: () => void, ms: number) => unknown;
  clearTimeoutFn: (h: unknown) => void;
  /** Longest we wait for in-flight interactions (a transition) before redirecting anyway. */
  fallbackMs?: number;
}

/**
 * Runs `run` once the current navigation transition has settled — never mid-push.
 * InteractionManager has no timeout (a handle that never clears would delay a
 * logged-in user's redirect indefinitely), so it is raced against a flat timer:
 * whichever fires first wins, the other becomes a no-op. Returns a canceller for
 * the effect's cleanup.
 */
export function scheduleSessionRedirect(d: SessionRedirectDeps): () => void {
  let fired = false;
  let cancelled = false;
  const fire = () => {
    if (fired || cancelled) return;
    fired = true;
    d.run();
  };
  const task = d.runAfterInteractions(fire);
  const timer = d.setTimeoutFn(fire, d.fallbackMs ?? 700);
  return () => {
    cancelled = true;
    task.cancel();
    d.clearTimeoutFn(timer);
  };
}
