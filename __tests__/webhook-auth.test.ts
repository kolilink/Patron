// Phase 9, Finding 6 — revenuecat-webhook compared the shared secret with a plain
// `!==` (early-exit string compare => timing oracle). Behaviour must be unchanged;
// the comparison must be constant-time.
import * as fs from 'fs';
import * as path from 'path';
import { bearerMatches, timingSafeEqualString } from '../supabase/functions/_shared/webhook-auth';

describe('bearerMatches (the revenuecat-webhook gate)', () => {
  it('accepts exactly "Bearer <secret>"', () => {
    expect(bearerMatches('Bearer s3cret', 's3cret')).toBe(true);
  });
  it('rejects a wrong secret, a prefix, an extension, wrong scheme, missing header', () => {
    expect(bearerMatches('Bearer s3cre', 's3cret')).toBe(false);
    expect(bearerMatches('Bearer s3cretX', 's3cret')).toBe(false);
    expect(bearerMatches('Bearer wrong!', 's3cret')).toBe(false);
    expect(bearerMatches('Basic s3cret', 's3cret')).toBe(false);
    expect(bearerMatches('s3cret', 's3cret')).toBe(false);
    expect(bearerMatches(null, 's3cret')).toBe(false);
    expect(bearerMatches(undefined, 's3cret')).toBe(false);
  });
  it('fails closed when the secret is not configured (even for an empty / "Bearer " header)', () => {
    expect(bearerMatches('', '')).toBe(false);
    expect(bearerMatches('Bearer ', '')).toBe(false);
    expect(bearerMatches('Bearer ', undefined)).toBe(false);
  });
  it('handles multibyte input without throwing', () => {
    expect(bearerMatches('Bearer é', 'é')).toBe(true);
    expect(bearerMatches('Bearer é', 'e')).toBe(false);
  });
});

describe('timingSafeEqualString examines every byte (no early exit)', () => {
  it('equal strings true, one differing byte anywhere false', () => {
    const a = 'x'.repeat(64);
    expect(timingSafeEqualString(a, a)).toBe(true);
    for (const i of [0, 31, 63]) {
      expect(timingSafeEqualString(a, a.slice(0, i) + 'y' + a.slice(i + 1))).toBe(false);
    }
  });
  it('a mismatch at byte 0 costs the same work as a mismatch at the last byte', () => {
    // Count byte reads via a proxy over TextEncoder output: instrumenting the loop
    // directly is not possible, so assert the invariant on the source instead —
    // the loop bound is the max length and there is no `return`/`break` inside it.
    const src = fs.readFileSync(path.join(__dirname, '../supabase/functions/_shared/webhook-auth.ts'), 'utf8');
    const loop = src.slice(src.indexOf('for (let i'), src.indexOf('return diff === 0'));
    expect(src).toMatch(/const len = Math\.max\(aB\.length, bB\.length\)/);
    expect(loop).toMatch(/for \(let i = 0; i < len; i\+\+\) diff \|=/);
    expect(loop).not.toMatch(/return|break/);
  });
});

describe('revenuecat-webhook source', () => {
  const src = fs.readFileSync(path.join(__dirname, '../supabase/functions/revenuecat-webhook/index.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  it('authorizes through bearerMatches, never a plain string comparison against the secret', () => {
    expect(src).toMatch(/bearerMatches\(/);
    expect(src).not.toMatch(/auth\s*[!=]==\s*`Bearer/);
    expect(src).not.toMatch(/[!=]==\s*`Bearer \$\{webhookAuthHeader\}`/);
  });
});
