// Phase 9, Finding 2 — money is never float. LOCAL TEST DB ONLY.
//
// Production's so_lines.unit_price is `real` (float4) while the migration chain
// says bigint. migration_v231 converts any drifted money column to an exact
// type and refuses (rather than rounds) when a conversion would change a value.
//
// Drift is simulated INSIDE a transaction (Postgres DDL is transactional) and
// rolled back, so no test leaks schema state into the others.
import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';
import { randomUUID } from 'crypto';
import { seedUser, seedBusiness, seedMember, seedProduct, seedSale } from './pgrole';
import { assertLocalDb, withPg } from './pg';

beforeAll(() => assertLocalDb());

const MIGRATION = fs.readFileSync(path.join(__dirname, '../../db/migration_v231.sql'), 'utf8');

async function colType(c: Client, table: string, col: string): Promise<string | null> {
  const r = await c.query(
    `SELECT data_type, numeric_precision, numeric_scale FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 AND column_name=$2`, [table, col]);
  if (!r.rows[0]) return null;
  const { data_type, numeric_precision, numeric_scale } = r.rows[0];
  return data_type === 'numeric' && numeric_precision ? `numeric(${numeric_precision},${numeric_scale})` : data_type;
}

/**
 * Runs `fn` in a rolled-back transaction on a superuser connection.
 *
 * LOCK DISCIPLINE (this suite shares one database with ~58 others running in
 * parallel): ALTER TABLE takes ACCESS EXCLUSIVE. Inside the transaction we therefore
 * only ever touch the table being altered (UPDATE/ALTER/read) — ALL seeding that
 * needs other tables (sale_orders, products, purchase_orders, FK parents) is
 * committed BEFORE the transaction begins. Seeding inside it held FK/row locks on
 * those parents while waiting on so_lines, and deadlocked against the
 * delete_business suite (CI run 37339229614: "deadlock detected").
 */
async function inTx<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  return withPg(async (c) => {
    await c.query('BEGIN');
    await c.query(`SET LOCAL lock_timeout = '30s'`);
    try { return await fn(c); } finally { await c.query('ROLLBACK'); }
  });
}

/** Committed (outside any DDL transaction) so_lines row with a harmless integer price; returns its order id. */
async function seedLine(price = 100): Promise<string> {
  const owner = await seedUser('mt-owner');
  const biz = await seedBusiness(owner);
  const prod = await seedProduct(biz, owner);
  const orderId = randomUUID();
  await withPg(async (c) => {
    await c.query(
      `INSERT INTO sale_orders (id, business_id, seller_id, created_by, status, total_amount, discount_amount, sale_date)
       VALUES ($1,$2,$3,$3,'paye',0,0,CURRENT_DATE)`, [orderId, biz, owner]);
    await c.query(
      `INSERT INTO so_lines (order_id, product_id, qty, unit_price, cost_price_at_sale, product_name)
       VALUES ($1,$2,1,$3,1,'x')`, [orderId, prod, price]);
  });
  return orderId;
}

const setUnitPrice = (c: Client, orderId: string, v: number | string) =>
  c.query(`UPDATE so_lines SET unit_price = $2 WHERE order_id = $1`, [orderId, v]);

describe('replayed schema: every money column is already exact (the migration is a no-op there)', () => {
  it('applying v231 to the clean chain changes nothing and does not raise', async () => {
    await inTx(async (c) => {
      const before = await c.query(`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema='public' ORDER BY 1,2`);
      await c.query(MIGRATION);
      const after = await c.query(`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema='public' ORDER BY 1,2`);
      expect(after.rows).toEqual(before.rows);
    });
  });
});

describe('production drift: so_lines.unit_price is real (float4)', () => {
  it('converts to bigint and preserves every stored value exactly (incl. > 2^24, where float4 spacing is 8-16)', async () => {
    const ids = [await seedLine(), await seedLine()];
    await inTx(async (c) => {
      await c.query(`ALTER TABLE so_lines ALTER COLUMN unit_price TYPE real USING unit_price::real`);
      expect(await colType(c, 'so_lines', 'unit_price')).toBe('real');
      // 150000 and 150000000 (1.5M GNF in cents) are both exactly representable in float4.
      await setUnitPrice(c, ids[0], 150000);
      await setUnitPrice(c, ids[1], 150000000);
      const stored = (await c.query(`SELECT unit_price::double precision AS v FROM so_lines WHERE order_id = ANY($1) ORDER BY unit_price`, [ids])).rows.map(r => r.v);

      await c.query(MIGRATION);

      expect(await colType(c, 'so_lines', 'unit_price')).toBe('bigint');
      const after = (await c.query(`SELECT unit_price::text AS v FROM so_lines WHERE order_id = ANY($1) ORDER BY unit_price`, [ids])).rows.map(r => Number(r.v));
      expect(after).toEqual(stored);                       // bit-for-bit what was stored
      expect(after).toEqual([150000, 150000000]);
    });
  });

  it('REFUSES (no silent rounding) when a drifted cents column holds a fractional value', async () => {
    const id = await seedLine();
    await inTx(async (c) => {
      await c.query(`ALTER TABLE so_lines ALTER COLUMN unit_price TYPE real USING unit_price::real`);
      await setUnitPrice(c, id, 1500.5); // not whole cents: looks like display units, scale unknown
      await expect(c.query(MIGRATION)).rejects.toThrow(/so_lines\.unit_price.*not whole cents/s);
    });
    // transaction rolled back: nothing changed outside it either
    await withPg(async c => expect(await colType(c, 'so_lines', 'unit_price')).toBe('bigint'));
  });

  it('also converts a production-only so_lines.unit_price_paid (referenced by v104 but never created by the chain)', async () => {
    const orderId = await seedLine(100000);
    await inTx(async (c) => {
      await c.query(`ALTER TABLE so_lines ADD COLUMN unit_price_paid real`);
      await c.query(`UPDATE so_lines SET unit_price_paid = 120000 WHERE order_id = $1`, [orderId]);
      await c.query(MIGRATION);
      expect(await colType(c, 'so_lines', 'unit_price_paid')).toBe('bigint');
      const r = await c.query(`SELECT unit_price_paid::text AS v FROM so_lines WHERE order_id = $1`, [orderId]);
      expect(r.rows[0].v).toBe('120000');
    });
  });

  it('leaves NULLs NULL', async () => {
    const orderId = await seedLine(100000);
    await inTx(async (c) => {
      await c.query(`ALTER TABLE so_lines ADD COLUMN unit_price_paid double precision`);
      await c.query(MIGRATION);
      const r = await c.query(`SELECT unit_price_paid FROM so_lines WHERE order_id = $1`, [orderId]);
      expect(r.rows[0].unit_price_paid).toBeNull();
    });
  });
});

describe('production drift: payments.amount is real AND views depend on it (kpi_core_actions -> kpi_business_activity -> call_list_*)', () => {
  it('v231 drops and recreates the whole dependent chain with owner, ACL and shape intact', async () => {
    await inTx(async (c) => {
      // dependencies first
      const ORDER = ['kpi_core_actions', 'kpi_business_activity', 'call_list_interview', 'call_list_referral', 'call_list_welcome'];
      const meta = async (v: string) => (await c.query(
        `SELECT relacl::text AS acl, pg_get_userbyid(relowner) AS owner, pg_get_viewdef(oid, true) AS def,
                (SELECT string_agg(attname || ':' || format_type(atttypid, atttypmod), ',' ORDER BY attnum)
                   FROM pg_attribute WHERE attrelid = pg_class.oid AND attnum > 0 AND NOT attisdropped) AS cols
         FROM pg_class WHERE relname = $1 AND relnamespace = 'public'::regnamespace`, [v])).rows[0];
      const before: Record<string, any> = {};
      for (const v of ORDER) before[v] = await meta(v);

      // Reproduce production: the column is float4 and the views sit on top of it.
      for (const v of [...ORDER].reverse()) await c.query(`DROP VIEW ${v}`);
      await c.query(`ALTER TABLE payments ALTER COLUMN amount TYPE real`);
      for (const v of ORDER) {
        await c.query(`CREATE VIEW ${v} AS ${before[v].def.replace(/;\s*$/, '')}`);
        await c.query(`REVOKE ALL ON ${v} FROM PUBLIC, anon, authenticated`);
        if (String(before[v].acl).includes('service_role')) await c.query(`GRANT ALL ON ${v} TO service_role`);
      }
      // sanity: without the fix Postgres refuses this conversion
      await c.query('SAVEPOINT s');
      await expect(c.query(`ALTER TABLE payments ALTER COLUMN amount TYPE bigint`)).rejects.toThrow(/depends on|cannot alter type/);
      await c.query('ROLLBACK TO SAVEPOINT s');

      await c.query(MIGRATION);

      expect(await colType(c, 'payments', 'amount')).toBe('bigint');
      for (const v of ORDER) {
        const after = await meta(v);
        expect(after.owner).toBe(before[v].owner);
        expect(after.cols).toBe(before[v].cols);
        expect(after.acl).toBe(before[v].acl);
        for (const role of ['anon', 'authenticated']) {
          const r = await c.query(`SELECT has_table_privilege($1, $2, 'SELECT') AS ok`, [role, `public.${v}`]);
          expect(r.rows[0].ok).toBe(false);
        }
        await c.query(`SELECT count(*) FROM ${v}`);
      }
    });
  });
});

describe('display-unit numeric money (po_lines.unit_cost numeric(15,2))', () => {
  it('a drifted float column becomes numeric(15,2) using the exact decimal the app wrote (12.34, not 12.3400001525879)', async () => {
    // committed seeding (outside the DDL transaction — see inTx)
    const owner = await seedUser('pl-owner'); const biz = await seedBusiness(owner); const prod = await seedProduct(biz, owner);
    const po = await withPg(async (c) => {
      const sup = (await c.query(`INSERT INTO suppliers (business_id, name, created_by) VALUES ($1,'S',$2) RETURNING id`, [biz, owner])).rows[0].id;
      const id = (await c.query(`INSERT INTO purchase_orders (business_id, supplier_id, total_cost, created_by) VALUES ($1,$2,0,$3) RETURNING id`, [biz, sup, owner])).rows[0].id;
      await c.query(`INSERT INTO po_lines (po_id, product_id, qty_ordered, unit_cost) VALUES ($1,$2,1,12.34)`, [id, prod]);
      return id as string;
    });
    await inTx(async (c) => {
      await c.query(`ALTER TABLE po_lines ALTER COLUMN unit_cost TYPE real USING unit_cost::real`);
      await c.query(MIGRATION);
      expect(await colType(c, 'po_lines', 'unit_cost')).toBe('numeric(15,2)');
      const r = await c.query(`SELECT unit_cost::text AS v FROM po_lines WHERE po_id = $1`, [po]);
      expect(r.rows[0].v).toBe('12.34');
    });
  });
});

describe('unknown float money columns are surfaced, not skipped', () => {
  it('raises on an unlisted float column whose name looks like money', async () => {
    await inTx(async (c) => {
      await c.query(`ALTER TABLE expenses ADD COLUMN surprise_total_amount real`);
      await expect(c.query(MIGRATION)).rejects.toThrow(/expenses\.surprise_total_amount/);
    });
  });
});

describe('report RPCs behave on BOTH the drifted (real) and the repaired (bigint) column type', () => {
  const asUserInTx = async (c: Client, sub: string) => {
    await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'authenticated', sub })]);
    await c.query('SET LOCAL ROLE authenticated');
  };

  it('get_best_sellers (admin path via *_unchecked, vendeur path inline) returns exact totals on real, and after v231', async () => {
    const admin = await seedUser('rp-admin'); const biz = await seedBusiness(admin);
    const vendeur = await seedUser('rp-vendeur'); await seedMember(biz, vendeur, 'vendeur');
    const prod = await seedProduct(biz, admin);
    await seedSale(biz, admin, prod, 2, 150000);
    await seedSale(biz, vendeur, prod, 1, 150000);
    const month = new Date().toISOString().slice(0, 8) + '01';

    for (const migrate of [false, true]) {
      await inTx(async (c) => {
        await c.query(`ALTER TABLE so_lines ALTER COLUMN unit_price TYPE real USING unit_price::real`);
        if (migrate) await c.query(MIGRATION);
        await asUserInTx(c, admin);
        const a = await c.query(`SELECT total_revenue::text AS r FROM get_best_sellers($1, $2, 5)`, [biz, month]);
        expect(Number(a.rows[0].r)).toBe(450000);
        await c.query('RESET ROLE');
        await asUserInTx(c, vendeur);
        const v = await c.query(`SELECT total_revenue::text AS r FROM get_best_sellers($1, $2, 5)`, [biz, month]);
        expect(Number(v.rows[0].r)).toBe(150000);
      });
    }
  });
});
