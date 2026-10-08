// CI guard for the single expenses visibility rule (migration_v235).
// A function that reads the `expenses` table directly (instead of through
// `expenses_visible`) would count soft-deleted rows, because SECURITY DEFINER
// bodies bypass RLS. This proves the guard is clean on db/ as it is, and — the
// part that matters — that it actually bites on a violating body.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const {
  findExpenseReadViolationsIn,
  findExpenseVisibilityViolations,
  EXPENSE_READ_ALLOWLIST,
} = require('../scripts/lib/expense-visibility');

const DB = path.resolve(__dirname, '..', 'db');

describe('expenses visibility guard — the repo', () => {
  it('no function reads the expenses table except through expenses_visible', () => {
    expect(findExpenseVisibilityViolations(DB)).toEqual([]);
  });

  it('bites on the real history: without v235 the v234 report functions are violations', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-vis-'));
    try {
      for (const f of fs.readdirSync(DB)) {
        // History as it stood BEFORE v235: skip v235 itself and every later migration
        // (a later one, e.g. v240's get_dashboard_kpis, re-defines a function through
        // expenses_visible and would legitimately hide the violation).
        const version = /^migration_v(\d+)\.sql$/.exec(f)?.[1];
        if ((version && Number(version) >= 235) || !/^(schema\.sql|migration_v\d+\.sql)$/.test(f)) continue;
        fs.copyFileSync(path.join(DB, f), path.join(dir, f));
      }
      const v = findExpenseVisibilityViolations(dir) as string[];
      for (const fn of ['get_reports_snapshot', 'get_period_report', 'get_dashboard_kpis', 'get_financial_snapshot', 'get_product_stats', 'run_display_checks']) {
        expect(v.some(x => x.includes(` ${fn} `) || x.includes(`: ${fn} `))).toBe(true);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the allowlist is exactly the two tombstone RPCs', () => {
    expect(Object.keys(EXPENSE_READ_ALLOWLIST).sort()).toEqual(['decide_expense', 'restore_expense', 'soft_delete_expense']);
  });
});

describe('expenses visibility guard — it bites on a deliberately violating body', () => {
  const entry = (name: string, body: string) => [{ name, body }];

  it('flags SELECT ... FROM expenses', () => {
    const v = findExpenseReadViolationsIn(entry('leaky_total', `CREATE FUNCTION leaky_total() RETURNS bigint AS $$ SELECT SUM(amount) FROM expenses WHERE status = 'approuve' $$ LANGUAGE sql SECURITY DEFINER;`));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/leaky_total/);
  });

  it('flags the alias, public-qualified, JOIN and comma-join forms', () => {
    for (const body of [
      'SELECT 1 FROM expenses e WHERE e.amount > 0',
      'SELECT 1 FROM public.expenses WHERE true',
      'SELECT 1 FROM businesses b JOIN expenses e ON e.business_id = b.id',
      'SELECT 1 FROM businesses b, expenses e WHERE e.business_id = b.id',
      'SELECT 1 FROM "expenses"',
    ]) {
      expect(findExpenseReadViolationsIn(entry('f', body))).toHaveLength(1);
    }
  });

  it('accepts the view, and writes (INSERT / UPDATE / DELETE targets)', () => {
    for (const body of [
      'SELECT SUM(amount) FROM expenses_visible WHERE true',
      'SELECT 1 FROM businesses b JOIN expenses_visible e ON e.business_id = b.id',
      'INSERT INTO expenses (id) VALUES (gen_random_uuid())',
      'UPDATE expenses SET status = \'rejete\' WHERE id = $1',
      'DELETE FROM expenses WHERE business_id = $1',
    ]) {
      expect(findExpenseReadViolationsIn(entry('f', body))).toEqual([]);
    }
  });

  it('the allowlist is by function name, so the same body elsewhere is still flagged', () => {
    const body = 'SELECT * FROM expenses WHERE id = $1';
    expect(findExpenseReadViolationsIn(entry('restore_expense', body))).toEqual([]);
    expect(findExpenseReadViolationsIn(entry('some_other_fn', body))).toHaveLength(1);
  });
});
