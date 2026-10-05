// In-flight guards: a tap on a slow connection must never run an action twice.
// The guard is synchronous (a plain flag, not React state), so a second tap
// that lands before the first re-render is still swallowed. Used both by the
// UI (src/hooks/useInFlight.ts) and by store actions, so the action is safe
// even if a caller forgets to disable its control.

export type GuardResult<T> = { ran: true; value: T } | { ran: false };

export interface InflightGuard {
  readonly busy: boolean;
  /** Runs fn unless one is already in flight (then returns { ran: false } without calling fn). Always releases, even on throw. */
  run<T>(fn: () => Promise<T>): Promise<GuardResult<T>>;
}

export function createInflightGuard(): InflightGuard {
  let busy = false;
  return {
    get busy() { return busy; },
    async run<T>(fn: () => Promise<T>): Promise<GuardResult<T>> {
      if (busy) return { ran: false };
      busy = true;
      try {
        return { ran: true, value: await fn() };
      } finally {
        busy = false;
      }
    },
  };
}

export interface KeyedInflightGuard {
  isBusy(key: string): boolean;
  run<T>(key: string, fn: () => Promise<T>): Promise<GuardResult<T>>;
}

/** One guard per key (e.g. per product id): different items run in parallel, the same item never twice. */
export function createKeyedInflightGuard(): KeyedInflightGuard {
  const active = new Set<string>();
  return {
    isBusy: key => active.has(key),
    async run<T>(key: string, fn: () => Promise<T>): Promise<GuardResult<T>> {
      if (active.has(key)) return { ran: false };
      active.add(key);
      try {
        return { ran: true, value: await fn() };
      } finally {
        active.delete(key);
      }
    },
  };
}
