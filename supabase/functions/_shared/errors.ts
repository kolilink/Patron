// Security audit 2026-09-27 (checklist 1.10 — "no stack traces or internal
// error details returned to the client"). Every auth/OTP edge function's
// catch-all used to do `err instanceof Error ? err.message : 'Erreur
// inconnue'` and return that straight to the caller — which faithfully
// relays whatever a raw Postgres/Supabase-admin error says (constraint
// names, column names, GoTrue internals) to an unauthenticated client
// whenever something unexpected fails, and never logged the real error
// server-side at all, so a genuine break was both leaked to the attacker
// and invisible to the founder.
//
// SafeError marks the small set of messages each function deliberately
// authors for the user (already French, already free of internal detail —
// "Numéro de téléphone invalide", "Code incorrect", etc.) — those are the
// only ones passed through verbatim. Anything else (a bare `throw
// somePostgrestError`, a TypeError, whatever) is logged in full via
// console.error and replaced with a fixed generic message before it
// reaches the response.
export class SafeError extends Error {}

const DEFAULT_FALLBACK = 'Une erreur est survenue. Réessayez dans quelques instants.';

export function safeErrorResponse(
  err: unknown,
  corsHeaders: Record<string, string>,
  context: string,
  fallback: string = DEFAULT_FALLBACK,
): Response {
  console.error(`${context}:`, err);
  const message = err instanceof SafeError ? err.message : fallback;
  return new Response(JSON.stringify({ error: message }), {
    status: 500,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
