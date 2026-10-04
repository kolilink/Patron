// Direct Postgres access for integration tests — LOCAL TEST DATABASE ONLY.
// Used for what PostgREST cannot see: pg_proc ACLs, policy text, and flipping
// auth.users.is_anonymous (anonymous sign-in is disabled in the local config).
import { Client } from 'pg';

const DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

/** Hard guard: these suites run raw SQL — never against a non-local database. */
export function assertLocalDb(): void {
  const host = new URL(DB_URL).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(`Refusing to run: DB host "${host}" is not the local test database`);
  }
}

export async function withPg<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  assertLocalDb();
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

export async function q<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  return withPg(async c => (await c.query(sql, params)).rows as T[]);
}

const FOUNDER_DIGITS = '12672421843'; // src/utils/founder.ts — is_founder() matches on these digits

/**
 * Make `userId` the (only) founder for the duration of a test. profiles.phone is
 * UNIQUE, so any leftover holder of the founder number (another suite, or an
 * earlier test) must be cleared first — otherwise the UPDATE fails and
 * is_founder() is silently false. Asserts the write really happened.
 */
export async function becomeFounder(userId: string): Promise<void> {
  await q(`UPDATE profiles SET phone = NULL WHERE regexp_replace(coalesce(phone,''), '\\D', '', 'g') = $1`, [FOUNDER_DIGITS]);
  const rows = await q(`UPDATE profiles SET phone = '+12672421843' WHERE id = $1 RETURNING id`, [userId]);
  if (rows.length !== 1) throw new Error('becomeFounder: could not set the founder phone');
}

export async function resignFounder(userId: string): Promise<void> {
  await q(`UPDATE profiles SET phone = NULL WHERE id = $1`, [userId]);
}
