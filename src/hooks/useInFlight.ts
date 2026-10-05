import { useCallback, useRef, useState } from 'react';
import { createInflightGuard, type GuardResult } from '@/lib/inflight';

/**
 * `const [busy, run] = useInFlight()` — `run(fn)` executes fn once at a time:
 * further taps while it is pending are swallowed (synchronously, so a
 * double-tap before re-render is still caught). `busy` drives the tapped
 * control's disabled state and its loading label.
 */
export function useInFlight(): [boolean, <T>(fn: () => Promise<T>) => Promise<GuardResult<T>>] {
  const guard = useRef(createInflightGuard()).current;
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<GuardResult<T>> => {
    if (guard.busy) return { ran: false };
    setBusy(true);
    try {
      return await guard.run(fn);
    } finally {
      setBusy(false);
    }
  }, [guard]);
  return [busy, run];
}
