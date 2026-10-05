// Constant-time shared-secret check for webhooks that authenticate with a static
// Authorization header (RevenueCat). Plain TS — no Deno APIs — so Jest can import it.
// Same technique as timingSafeEqualHex (_shared/djomi.ts) and verify-phone-code:
// walk the full max length and OR the byte differences, so response time does not
// reveal how many leading characters of a guess were right.

export function timingSafeEqualString(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aB = enc.encode(a);
  const bB = enc.encode(b);
  let diff = aB.length ^ bB.length;
  const len = Math.max(aB.length, bB.length);
  for (let i = 0; i < len; i++) diff |= (aB[i] ?? 0) ^ (bB[i] ?? 0);
  return diff === 0;
}

/**
 * True only when `header` is exactly `Bearer <secret>`. An unset/empty secret
 * never authorizes anything (fails closed), even against an empty header.
 */
export function bearerMatches(header: string | null | undefined, secret: string | undefined): boolean {
  if (!secret) return false;
  return timingSafeEqualString(header ?? '', `Bearer ${secret}`);
}
