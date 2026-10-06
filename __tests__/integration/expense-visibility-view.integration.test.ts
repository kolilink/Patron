// migration_v235 on a real Postgres: one visibility rule for expenses.
// LOCAL TEST DB ONLY (plain-pg harness).
import { as, tryAs, seedUser, seedBusiness, user } from './pgrole';
import { assertLocalDb, q, withPg } from './pg';

const { findExpenseReadViolationsIn } = require('../../scripts/lib/expense-visibility');

beforeAll(() => assertLocalDb());

const REPORT_FUNCTIONS = [
  'get_business_kpis', 'get_product_stats', 'get_dashboard_kpis', 'get_financial_snapshot',
  'get_reports_snapshot', 'get_period_report', 'run_display_checks',
];

async function liveDefs(): Promise<{ name: string; body: string }[]> {
  const rows = await q<{ name: string; def: string }>(
    `SELECT p.proname AS name, pg_get_functiondef(p.oid) AS def
       FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'`);
  return rows.map(r => ({ name: r.name, body: r.def }));
}

describe('expenses_visible view', () => {
  it('exists with an explicit column list (no select *) and excludes the tombstone columns', async () => {
    const cols = (await q<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='expenses_visible' ORDER BY ordinal_position`)).map(r => r.column_name);
    expect(cols).toEqual(expect.arrayContaining(['id', 'business_id', 'amount', 'status', 'date', 'product_id', 'proof_image_url']));
    expect(cols).not.toContain('deleted_at');
    expect(cols).not.toContain('deleted_by');
    const def = (await q<{ d: string }>(`SELECT pg_get_viewdef('expenses_visible'::regclass) AS d`))[0].d;
    expect(def).not.toMatch(/\*/);
    expect(def).toMatch(/deleted_at IS NULL/);
  });

  it('every live expenses column is exposed, or is a tombstone column — a new column without a re-issued view fails here', async () => {
    const table = (await q<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='expenses'`)).map(r => r.column_name);
    const view = (await q<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='expenses_visible'`)).map(r => r.column_name);
    const missing = table.filter(c => !view.includes(c) && c !== 'deleted_at' && c !== 'deleted_by');
    expect(missing).toEqual([]);
  });

  it('is not readable by app roles (it runs with owner rights, so it must not be a back door around RLS)', async () => {
    const id = await seedUser('view-acl');
    const biz = await seedBusiness(id, 'View ACL');
    void biz;
    const asAuth = await tryAs(user(id), 'SELECT * FROM expenses_visible LIMIT 1');
    expect(asAuth.error?.code).toBe('42501');
    const anon = await tryAs({ role: 'anon' }, 'SELECT * FROM expenses_visible LIMIT 1');
    expect(anon.error?.code).toBe('42501');
  });
});

describe('the report functions read the view, not the table', () => {
  it.each(REPORT_FUNCTIONS)('%s reads expenses_visible and carries no manual filter', async (fn) => {
    const def = (await q<{ d: string }>(
      `SELECT pg_get_functiondef(oid) AS d FROM pg_proc WHERE proname = $1 AND pronamespace='public'::regnamespace`, [fn]))[0].d;
    expect(def).toMatch(/\bexpenses_visible\b/);
    expect(def).not.toMatch(/deleted_at/);
    expect(findExpenseReadViolationsIn([{ name: fn, body: def }])).toEqual([]);
  });
});

describe('live guard: no function in the database reads the expenses table directly', () => {
  it('pg_get_functiondef scan is clean', async () => {
    expect(findExpenseReadViolationsIn(await liveDefs())).toEqual([]);
  });

  it('bites: a function that reads expenses directly is caught by the same scan', async () => {
    await withPg(async (c) => {
      await c.query('BEGIN');
      try {
        await c.query(`CREATE FUNCTION public.zz_leaky_expense_total() RETURNS bigint LANGUAGE sql SECURITY DEFINER
                         AS $$ SELECT COALESCE(SUM(amount), 0)::bigint FROM expenses WHERE status = 'approuve' $$`);
        const defs = (await c.query(
          `SELECT p.proname AS name, pg_get_functiondef(p.oid) AS body FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'`)).rows;
        const v = findExpenseReadViolationsIn(defs) as string[];
        expect(v).toHaveLength(1);
        expect(v[0]).toMatch(/zz_leaky_expense_total/);
      } finally {
        await c.query('ROLLBACK');
      }
    });
  });
});

describe('the view is enforced inside SECURITY DEFINER bodies (unlike RLS)', () => {
  it('a definer function reading the view never sees a tombstone', async () => {
    const admin = await seedUser('view-admin');
    const biz = await seedBusiness(admin, 'View journey');
    await as(user(admin), async c => {
      await c.query(
        `INSERT INTO expenses (id, business_id, amount, description, date, status, created_by)
         VALUES (gen_random_uuid(), $1, 1000, 'a', CURRENT_DATE, 'approuve', $2),
                (gen_random_uuid(), $1, 2000, 'b', CURRENT_DATE, 'approuve', $2)`, [biz, admin]);
    }, true);
    await q(`UPDATE expenses SET deleted_at = now(), deleted_by = $2 WHERE business_id = $1 AND amount = 2000`, [biz, admin]);
    const r = await tryAs(user(admin), 'SELECT get_dashboard_kpis($1, CURRENT_DATE) AS r', [biz]);
    expect(Number(r.rows![0].r.expenses_month)).toBe(1000);
  });
});
