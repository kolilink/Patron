// Role-switching harness over a plain Postgres connection — LOCAL TEST DB ONLY.
//
// The PostgREST-based helpers (helpers.ts) need the full `supabase start`
// stack. The Phase 9 security suites only need Postgres to enforce what it
// enforces on production: EXECUTE grants per role, RLS, and auth.uid() derived
// from the JWT claims. So these tests run a real transaction as
// `SET LOCAL ROLE anon|authenticated|service_role` with `request.jwt.claims`
// set — the exact mechanism PostgREST uses — and assert on real rows.
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { assertLocalDb, withPg } from './pg';

export type Identity =
  | { role: 'anon' }
  | { role: 'service_role' }
  | { role: 'authenticated'; sub: string };

export const ANON: Identity = { role: 'anon' };
export const SERVICE: Identity = { role: 'service_role' };
export const user = (sub: string): Identity => ({ role: 'authenticated', sub });

/** Runs `fn` inside a transaction as `who`; always rolled back unless commit=true. */
export async function as<T>(who: Identity, fn: (c: Client) => Promise<T>, commit = false): Promise<T> {
  assertLocalDb();
  return withPg(async (c) => {
    await c.query('BEGIN');
    try {
      const claims = who.role === 'authenticated'
        ? { role: 'authenticated', sub: who.sub }
        : { role: who.role };
      await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
      await c.query(`SET LOCAL ROLE ${who.role}`);
      const out = await fn(c);
      await c.query(commit ? 'COMMIT' : 'ROLLBACK');
      return out;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    }
  });
}

/** Run a statement as `who` and return either {rows} or {error:{code,message}} (never throws on SQL errors). */
export async function tryAs(who: Identity, sql: string, params: any[] = []): Promise<{ rows?: any[]; error?: { code?: string; message: string } }> {
  try {
    const rows = await as(who, async (c) => (await c.query(sql, params)).rows);
    return { rows };
  } catch (e: any) {
    return { error: { code: e.code, message: e.message } };
  }
}

/** Creates an auth user (the on_auth_user_created trigger makes the profile). Runs as the superuser. */
export async function seedUser(label: string, opts: { anonymous?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  await withPg(c => c.query(
    `INSERT INTO auth.users (id, email, is_anonymous) VALUES ($1, $2, $3)`,
    [id, `${label}-${id}@test.local`, !!opts.anonymous],
  ));
  return id;
}

export async function seedBusiness(ownerId: string, name = 'Commerce test'): Promise<string> {
  const id = randomUUID();
  await as(user(ownerId), c => c.query(
    `SELECT create_business_with_membership($1, $2, 'commerce', 'GNF', NULL)`, [id, name]), true);
  return id;
}

export async function seedMember(businessId: string, userId: string, role: 'manager' | 'vendeur' | 'investisseur'): Promise<void> {
  await withPg(c => c.query(
    `INSERT INTO memberships (business_id, user_id, role) VALUES ($1, $2, $3)`, [businessId, userId, role]));
}

export async function seedProduct(businessId: string, createdBy: string, o: { name?: string; cost?: number; price?: number } = {}): Promise<string> {
  const id = randomUUID();
  await withPg(c => c.query(
    `INSERT INTO products (id, business_id, name, unit, stock_qty, cost_price, sale_price, reorder_level, created_by)
     VALUES ($1,$2,$3,'unite',100,$4,$5,0,$6)`,
    [id, businessId, o.name ?? 'Produit', o.cost ?? 50000, o.price ?? 100000, createdBy]));
  return id;
}

/** A paid sale of `qty` x `unitPrice` (cents) by `sellerId`, written as superuser (setup only). */
export async function seedSale(businessId: string, sellerId: string, productId: string, qty: number, unitPrice: number): Promise<string> {
  const id = randomUUID();
  await withPg(async (c) => {
    await c.query(
      `INSERT INTO sale_orders (id, business_id, seller_id, created_by, status, total_amount, discount_amount, sale_date, paid_at, is_credit)
       VALUES ($1,$2,$3,$3,'paye',$4,0,CURRENT_DATE,now(),false)`, [id, businessId, sellerId, qty * unitPrice]);
    await c.query(
      `INSERT INTO so_lines (order_id, product_id, qty, unit_price, cost_price_at_sale, product_name)
       VALUES ($1,$2,$3,$4,50000,'Produit')`, [id, productId, qty, unitPrice]);
    await c.query(
      `INSERT INTO payments (order_id, business_id, amount, method, date) VALUES ($1,$2,$3,'especes',CURRENT_DATE)`,
      [id, businessId, qty * unitPrice]);
  });
  return id;
}
