// Dependency-free error classification. Lives in its own module (and is
// re-exported from lib/sync.ts, so every existing import keeps working) because
// pure helpers — src/utils/failure.ts and anything built on it — need
// isNetworkError WITHOUT dragging in lib/sync.ts -> lib/supabase.ts, whose
// createClient() starts a realtime client at import time. On Node 20 (CI) that
// throws "Node.js 20 detected without native WebSocket support"; on Node 22+
// (a laptop) it silently works, which is how a test importing only failure
// helpers passed locally and failed in CI. Keep this file free of imports.

// Shared by isNetworkError() and reportOfflineFallback() — a raw Error
// instance is the exception, not the rule, in this codebase: by default
// (no .throwOnError()), a failed Supabase call resolves with a plain
// PostgrestError-shaped OBJECT ({ message, code, details, hint }), not a
// thrown Error. String(plainObject) is the literal text "[object Object]",
// not its message — isNetworkError() has always special-cased this (see
// __tests__/offline-resilience.test.ts's regression guard); this used to be
// duplicated ad hoc rather than shared, and reportOfflineFallback() was
// missing the object-shape branch entirely, so every Sentry event for the
// (most common) plain-object case logged "[object Object]" instead of the
// actual message — silently defeating its own purpose.
export function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message);
  return String(err);
}

export function isNetworkError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true;
  const msg = extractErrorMessage(err).toLowerCase();
  return (
    msg.includes('fetch') ||
    msg.includes('network') ||
    msg.includes('failed to connect') ||
    msg.includes('econnrefused') ||
    msg.includes('etimedout') ||
    msg.includes('timeout') ||
    msg.includes('offline') ||
    msg.includes('load failed')
  );
}
