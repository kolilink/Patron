// Cache-write diagnostics. Every offline read cache is written fire-and-forget
// (`void saveXCache(...)`), and the writers swallow their errors by design — a
// failed cache write must never break the screen that triggered it. But that
// swallowed failure used to leave "I was online, yet the cache is empty offline"
// with ZERO trace. Now every failure is logged, counted per table, reported
// (Sentry, via the reporter the root layout installs) and exposed as a flag the
// Paramètres diagnostic line reads. A later successful write to the same table
// clears that table's entry — the flag only means "this table is failing NOW".
import { create } from 'zustand';

export interface CacheFailure { count: number; lastAt: number; lastError: string }

interface CacheHealthState {
  failures: Record<string, CacheFailure>;
}

export const useCacheHealthStore = create<CacheHealthState>(() => ({ failures: {} }));

let reporter: ((table: string, err: unknown) => void) | null = null;
/** The root layout installs Sentry/analytics here (lib/db must not import them). */
export function setCacheFailureReporter(fn: ((table: string, err: unknown) => void) | null): void {
  reporter = fn;
}

export function recordCacheWriteFailure(table: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[cache] write to ${table} FAILED — offline data for this table may be missing:`, message);
  useCacheHealthStore.setState(s => {
    const prev = s.failures[table];
    return { failures: { ...s.failures, [table]: { count: (prev?.count ?? 0) + 1, lastAt: Date.now(), lastError: message } } };
  });
  try { reporter?.(table, err); } catch { /* diagnostics must never throw */ }
}

export function recordCacheWriteSuccess(table: string): void {
  const { failures } = useCacheHealthStore.getState();
  if (!failures[table]) return;
  const { [table]: _gone, ...rest } = failures;
  useCacheHealthStore.setState({ failures: rest });
}

/** Tables currently failing, for the diagnostic line. */
export function failingCacheTables(failures: Record<string, CacheFailure>): string[] {
  return Object.keys(failures).sort();
}
