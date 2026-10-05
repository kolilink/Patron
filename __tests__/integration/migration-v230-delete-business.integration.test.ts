// migration_v230 — delete_business() must work on a business that has sales.
// LOCAL TEST DB ONLY (assertLocalDb). Talks to Postgres directly so the call
// runs as the founder via a simulated JWT (SET LOCAL ROLE authenticated +
// request.jwt.claims), exactly the context PostgREST gives an RPC.
//
// v165's body died with 23503 on (1) so_lines/stock_moves/po_lines RESTRICT
// references to products and (2) v210's trg_bump_version_* triggers upserting
// business_data_versions for the business being deleted.
import { randomUUID } from 'crypto';
import type { Client } from 'pg';
import { assertLocalDb, q, withPg, becomeFounder } from './pg';

beforeAll(() => assertLocalDb());

const TRIGGERS: Array<[string, string]> = [
  ['sale_orders', 'trg_bump_version_sale_orders'],
  ['so_lines', 'trg_bump_version_so_lines'],
  ['payments', 'trg_bump_version_payments'],
  ['stock_moves', 'trg_bump_version_stock_moves'],
  ['products', 'trg_bump_version_products'],
  ['product_variants', 'trg_bump_version_product_variants'],
  ['clients', 'trg_bump_version_clients'],
  ['businesses', 'trg_bump_version_businesses'],
  ['suppliers', 'suppliers_guard_delete'], // v213 guard, muted too (see v230 header, cause 3)
];

async function makeUser(label: string): Promise<string> {
  const id = randomUUID();
  // The on_auth_user_created trigger creates the matching profiles row.
  await q(
    `INSERT INTO auth.users (id, aud, role, email) VALUES ($1, 'authenticated', 'authenticated', $2)`,
    [id, `${label}-${id.slice(0, 8)}@test.local`],
  );
  return id;
}

/** Run `fn` as `userId` (authenticated role + JWT sub), in one transaction. */
async function asUser<T>(userId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  return withPg(async c => {
    await c.query('BEGIN');
    try {
      await c.query('SET LOCAL ROLE authenticated');
      await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: userId, role: 'authenticated' }),
      ]);
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    }
  });
}

interface Seeded {
  businessId: string;
  ownerId: string;
  ids: Record<string, string[]>;
}

/** A business with every child kind the delete has to get through. */
async function seedBusinessWithActivity(ownerId: string, name: string): Promise<Seeded> {
  const businessId = randomUUID();
  const productId = randomUUID();
  const productId2 = randomUUID();
  const clientId = randomUUID();
  const supplierId = randomUUID();
  const saleId = randomUUID();
  const soLineId = randomUUID();
  const poId = randomUUID();
  const poLineId = randomUUID();
  const moveId = randomUUID();
  const paymentId = randomUUID();
  const debtId = randomUUID();

  // on_business_created inserts the admin membership from auth.uid(), so the
  // insert must carry the owner's JWT claim (still the superuser role).
  await withPg(async c => {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: ownerId, role: 'authenticated' })]);
    await c.query(`INSERT INTO businesses (id, name, created_by) VALUES ($1, $2, $3)`, [businessId, name, ownerId]);
    await c.query('COMMIT');
  });
  await q(`INSERT INTO products (id, business_id, name, created_by) VALUES ($1,$2,'Riz',$3), ($4,$2,'Huile',$3)`,
    [productId, businessId, ownerId, productId2]);
  await q(`INSERT INTO clients (id, business_id, name) VALUES ($1,$2,'Client A')`, [clientId, businessId]);
  await q(`INSERT INTO suppliers (id, business_id, name, created_by) VALUES ($1,$2,'Fournisseur',$3)`,
    [supplierId, businessId, ownerId]);
  await q(`INSERT INTO sale_orders (id, business_id, seller_id, created_by, client_id) VALUES ($1,$2,$3,$3,$4)`,
    [saleId, businessId, ownerId, clientId]);
  await q(`INSERT INTO so_lines (id, order_id, product_id, qty, unit_price) VALUES ($1,$2,$3,2,100000)`,
    [soLineId, saleId, productId]);
  await q(`INSERT INTO payments (id, order_id, business_id, method, amount) VALUES ($1,$2,$3,'especes',200000)`,
    [paymentId, saleId, businessId]);
  await q(`INSERT INTO purchase_orders (id, business_id, supplier_id, created_by) VALUES ($1,$2,$3,$4)`,
    [poId, businessId, supplierId, ownerId]);
  await q(`INSERT INTO po_lines (id, po_id, product_id, qty_ordered, unit_cost) VALUES ($1,$2,$3,5,100)`,
    [poLineId, poId, productId2]);
  // Unpaid supplier debt: also trips v213's guard on a supplier delete.
  await q(`INSERT INTO supplier_debts (id, business_id, supplier_id, amount, amount_paid, created_by) VALUES ($1,$2,$3,500000,0,$4)`,
    [debtId, businessId, supplierId, ownerId]);
  await q(`INSERT INTO stock_moves (id, business_id, product_id, type, qty, created_by) VALUES ($1,$2,$3,'sortie',2,$4)`,
    [moveId, businessId, productId, ownerId]);

  return {
    businessId,
    ownerId,
    ids: {
      products: [productId, productId2],
      clients: [clientId],
      suppliers: [supplierId],
      supplier_debts: [debtId],
      sale_orders: [saleId],
      so_lines: [soLineId],
      payments: [paymentId],
      purchase_orders: [poId],
      po_lines: [poLineId],
      stock_moves: [moveId],
    },
  };
}

async function count(table: string, ids: string[]): Promise<number> {
  const r = await q<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE id = ANY($1::uuid[])`, [ids]);
  return Number(r[0].n);
}

async function triggerStates(): Promise<Record<string, string>> {
  const rows = await q<{ tgname: string; tgenabled: string }>(
    `SELECT tgname, tgenabled FROM pg_trigger WHERE tgname LIKE 'trg_bump_version_%' OR tgname = 'suppliers_guard_delete'`,
  );
  return Object.fromEntries(rows.map(r => [r.tgname, r.tgenabled]));
}

describe('migration_v230 — delete_business on a business with sales', () => {
  it('removes the business and every child row, including its business_data_versions row', async () => {
    const founderId = await makeUser('founder');
    await becomeFounder(founderId);
    const ownerId = await makeUser('owner');
    const s = await seedBusinessWithActivity(ownerId, 'Boutique avec ventes');

    // The seed inserts fired the bump triggers: the version row exists now.
    const before = await q(`SELECT 1 FROM business_data_versions WHERE business_id = $1`, [s.businessId]);
    expect(before).toHaveLength(1);

    await asUser(founderId, c => c.query(`SELECT delete_business($1)`, [s.businessId]));

    expect(await q(`SELECT 1 FROM businesses WHERE id = $1`, [s.businessId])).toHaveLength(0);
    for (const [table, ids] of Object.entries(s.ids)) {
      expect({ table, left: await count(table, ids) }).toEqual({ table, left: 0 });
    }
    expect(await q(`SELECT 1 FROM memberships WHERE business_id = $1`, [s.businessId])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM business_data_versions WHERE business_id = $1`, [s.businessId])).toHaveLength(0);
  });

  it('only touches the target business — a second business with sales is left intact', async () => {
    const founderId = await makeUser('founder2');
    await becomeFounder(founderId);
    const ownerId = await makeUser('owner2');
    const target = await seedBusinessWithActivity(ownerId, 'À supprimer');
    const keeper = await seedBusinessWithActivity(ownerId, 'À garder');

    await asUser(founderId, c => c.query(`SELECT delete_business($1)`, [target.businessId]));

    expect(await q(`SELECT 1 FROM businesses WHERE id = $1`, [keeper.businessId])).toHaveLength(1);
    for (const [table, ids] of Object.entries(keeper.ids)) {
      expect({ table, left: await count(table, ids) }).toEqual({ table, left: ids.length });
    }
    expect(await q(`SELECT 1 FROM business_data_versions WHERE business_id = $1`, [keeper.businessId])).toHaveLength(1);
  });

  it('leaves all 8 trg_bump_version_* triggers + suppliers_guard_delete enabled, and they still bump afterwards', async () => {
    const founderId = await makeUser('founder3');
    await becomeFounder(founderId);
    const ownerId = await makeUser('owner3');
    const target = await seedBusinessWithActivity(ownerId, 'Cible');
    const other = await seedBusinessWithActivity(ownerId, 'Autre');

    await asUser(founderId, c => c.query(`SELECT delete_business($1)`, [target.businessId]));

    const states = await triggerStates();
    for (const [, trg] of TRIGGERS) expect({ trg, state: states[trg] }).toEqual({ trg, state: 'O' });

    const v0 = Number((await q<{ version: string }>(
      `SELECT version::text FROM business_data_versions WHERE business_id = $1`, [other.businessId]))[0].version);
    await q(`INSERT INTO sale_orders (id, business_id, seller_id, created_by) VALUES ($1,$2,$3,$3)`,
      [randomUUID(), other.businessId, ownerId]);
    const v1 = Number((await q<{ version: string }>(
      `SELECT version::text FROM business_data_versions WHERE business_id = $1`, [other.businessId]))[0].version);
    expect(v1).toBeGreaterThan(v0);
  });

  it('re-enables the triggers when the delete fails midway (error path), then re-raises', async () => {
    const founderId = await makeUser('founder4');
    await becomeFounder(founderId);
    const ownerId = await makeUser('owner4');
    const s = await seedBusinessWithActivity(ownerId, 'Échec forcé');

    // A BEFORE DELETE trigger on businesses that always fails, so the delete
    // blows up AFTER the triggers were muted.
    await q(`CREATE OR REPLACE FUNCTION _v230_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'v230 boom' USING ERRCODE = 'P0001'; END $$`);
    // WHEN-scoped to this test's business: the table is shared with every other suite running in parallel,
    // and an unscoped trigger made unrelated deletes (finalize-account-deletion) fail with 'v230 boom'.
    await q(`CREATE TRIGGER _v230_boom BEFORE DELETE ON businesses FOR EACH ROW WHEN (OLD.id = '${s.businessId}') EXECUTE FUNCTION _v230_boom()`);
    try {
      await expect(
        asUser(founderId, c => c.query(`SELECT delete_business($1)`, [s.businessId])),
      ).rejects.toMatchObject({ message: expect.stringContaining('v230 boom') });
    } finally {
      await q(`DROP TRIGGER IF EXISTS _v230_boom ON businesses`);
      await q(`DROP FUNCTION IF EXISTS _v230_boom()`);
    }

    const states = await triggerStates();
    for (const [, trg] of TRIGGERS) expect({ trg, state: states[trg] }).toEqual({ trg, state: 'O' });
    // Whole call rolled back: the business and its children are still there.
    expect(await q(`SELECT 1 FROM businesses WHERE id = $1`, [s.businessId])).toHaveLength(1);
    for (const [table, ids] of Object.entries(s.ids)) {
      expect({ table, left: await count(table, ids) }).toEqual({ table, left: ids.length });
    }
  });

  it('a non-founder still gets "Accès refusé" and nothing is deleted', async () => {
    const founderId = await makeUser('founder5'); // make sure a founder exists, but the caller is not it
    await becomeFounder(founderId);
    const ownerId = await makeUser('owner5');
    const s = await seedBusinessWithActivity(ownerId, 'Protégé');

    await expect(
      asUser(ownerId, c => c.query(`SELECT delete_business($1)`, [s.businessId])),
    ).rejects.toMatchObject({ code: 'P0001', message: 'Accès refusé' });

    expect(await q(`SELECT 1 FROM businesses WHERE id = $1`, [s.businessId])).toHaveLength(1);
    for (const [table, ids] of Object.entries(s.ids)) {
      expect({ table, left: await count(table, ids) }).toEqual({ table, left: ids.length });
    }
    const states = await triggerStates();
    for (const [, trg] of TRIGGERS) expect({ trg, state: states[trg] }).toEqual({ trg, state: 'O' });
  });
});
