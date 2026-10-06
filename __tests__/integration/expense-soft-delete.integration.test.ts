// Expense flow redesign — soft delete enforced by the DATABASE (migration_v234).
// LOCAL TEST DB ONLY (pg-role harness: SET LOCAL ROLE + request.jwt.claims).
//
// Proves, on a real Postgres: a deleted expense vanishes from every total
// without any query remembering a filter; link set/unlink/SET NULL; the
// delete/restore RPC gates; and the full add -> undo -> add -> edit -> delete
// journey keeps the month total equal to SUM(visible rows) at every step.
import { randomUUID } from 'crypto';
import { as, tryAs as readAs, seedUser, seedBusiness, seedMember, seedProduct, seedSale, user, ANON } from './pgrole';
import { assertLocalDb, q } from './pg';

beforeAll(() => assertLocalDb());

// Mutations must COMMIT (the harness rolls back by default); a SQL error is
// returned, not thrown, so a test can assert a refusal. Reads use readAs.
async function tryAs(who: any, sql: string, params: any[] = []): Promise<{ rows?: any[]; error?: { code?: string; message: string } }> {
  try {
    const rows = await as(who, async c => (await c.query(sql, params)).rows, true);
    return { rows };
  } catch (e: any) {
    return { error: { code: e.code, message: e.message } };
  }
}
void readAs;

const today = new Date().toISOString().slice(0, 10);
const monthStart = today.slice(0, 8) + '01';

let admin: string, manager: string, vendeur: string, investor: string, outsider: string;
let biz: string, otherBiz: string, rice: string, oil: string;

beforeAll(async () => {
  admin = await seedUser('admin');
  manager = await seedUser('manager');
  vendeur = await seedUser('vendeur');
  investor = await seedUser('investor');
  outsider = await seedUser('outsider');
  biz = await seedBusiness(admin, 'Commerce dépenses');
  await seedMember(biz, manager, 'manager');
  await seedMember(biz, vendeur, 'vendeur');
  await seedMember(biz, investor, 'investisseur');
  otherBiz = await seedBusiness(outsider, 'Autre commerce');
  rice = await seedProduct(biz, admin, { name: 'Riz 50 kg' });
  oil = await seedProduct(biz, admin, { name: 'Huile' });
});

// ── helpers ──────────────────────────────────────────────────────────────────
async function addExpense(who: string, amount: number, productId: string | null, status = 'approuve'): Promise<string> {
  const id = randomUUID();
  const r = await tryAs(user(who),
    `INSERT INTO expenses (id, business_id, amount, description, date, product_id, status, created_by)
     VALUES ($1,$2,$3,'Dépense',CURRENT_DATE,$4,$5,$6)`,
    [id, biz, amount, productId, status, who]);
  expect(r.error).toBeUndefined();
  return id;
}
const del = (who: string, id: string) => tryAs(user(who), 'SELECT soft_delete_expense($1) AS ok', [id]);
const restore = (who: string, id: string) => tryAs(user(who), 'SELECT restore_expense($1) AS ok', [id]);
const visibleSum = async (who = admin) =>
  Number((await tryAs(user(who), `SELECT COALESCE(SUM(amount),0)::bigint AS s FROM expenses WHERE business_id=$1 AND status='approuve'`, [biz])).rows![0].s);
const dashboardMonth = async () =>
  Number((await tryAs(user(admin), 'SELECT get_dashboard_kpis($1,$2) AS r', [biz, today])).rows![0].r.expenses_month);
// get_period_report exposes expenses only through cash_on_hand (all-time
// payments + capital - expenses ...); with no payments/capital in this
// business it equals minus the live expense sum.
const periodOper = async () =>
  0 - Number((await tryAs(user(admin), 'SELECT get_period_report($1,$2,$3,$4,$5) AS r', [biz, monthStart, today, 'administrateur', admin])).rows![0].r.cash_on_hand);
const snapshotOper = async () =>
  Number((await tryAs(user(admin), 'SELECT get_reports_snapshot($1,30,$2,$3,$4) AS r', [biz, 'administrateur', admin, today])).rows![0].r.operating_expenses);
// get_business_kpis is dead code (no caller) and was already broken before
// this migration (`date >= text`), so it is patched but not asserted here.
const hardCount = async (id: string) =>
  Number((await q('SELECT COUNT(*)::int AS n FROM expenses WHERE id=$1', [id]))[0].n);

async function expectAllTotals(expected: number) {
  expect(await visibleSum()).toBe(expected);
  expect(await dashboardMonth()).toBe(expected);
  expect(await periodOper()).toBe(expected);
  expect(await snapshotOper()).toBe(expected);
}

// ── journey ──────────────────────────────────────────────────────────────────
describe('full journey — every total equals SUM of visible rows at every step', () => {
  it('add with product -> undo -> add again -> edit (change link) -> delete -> undo delete', async () => {
    await expectAllTotals(0);

    const a = await addExpense(admin, 2500000, rice);          // 25 000 GNF
    await expectAllTotals(2500000);

    // undo of the create = the delete code path
    expect((await del(admin, a)).rows![0].ok).toBe(true);
    await expectAllTotals(0);
    expect(await hardCount(a)).toBe(1);                         // soft, never a hard delete

    const b = await addExpense(admin, 2500000, rice);
    await expectAllTotals(2500000);

    // edit = plain UPDATE through the normal path; change amount AND the link
    const upd = await tryAs(user(admin), 'UPDATE expenses SET amount=$2, product_id=$3 WHERE id=$1', [b, 3000000, oil]);
    expect(upd.error).toBeUndefined();
    await expectAllTotals(3000000);
    const linked = await q('SELECT product_id FROM expenses WHERE id=$1', [b]);
    expect(linked[0].product_id).toBe(oil);

    // unlink
    await tryAs(user(admin), 'UPDATE expenses SET product_id=NULL WHERE id=$1', [b]);
    expect((await q('SELECT product_id FROM expenses WHERE id=$1', [b]))[0].product_id).toBeNull();

    const c = await addExpense(admin, 100000, null);
    await expectAllTotals(3100000);

    expect((await del(admin, b)).rows![0].ok).toBe(true);
    await expectAllTotals(100000);

    // undo of a delete restores it; totals move back
    expect((await restore(admin, b)).rows![0].ok).toBe(true);
    await expectAllTotals(3100000);

    await del(admin, c);
    await del(admin, b);
    await expectAllTotals(0);
  });

  it('financial snapshot (ledger recompute) ignores deleted rows too', async () => {
    const p = await seedProduct(biz, admin, { name: 'Pour snapshot' });
    await seedSale(biz, admin, p, 1, 100000);                 // snapshot lists a currency only with revenue
    const gnfMonthExpenses = async () => {
      const r = await q(`SELECT get_financial_snapshot() AS r`);
      return Number((r[0].r as any[]).find(x => x.currency === 'GNF').month_to_date.expenses);
    };
    const base = await gnfMonthExpenses();
    const id = await addExpense(admin, 777000, null);
    expect(await gnfMonthExpenses()).toBe(base + 777000);
    await del(admin, id);
    expect(await gnfMonthExpenses()).toBe(base);
  });
});

// ── RLS ──────────────────────────────────────────────────────────────────────
describe('RLS: deleted rows are invisible to app roles', () => {
  it('no app role can SELECT a deleted expense, direct query, any filter', async () => {
    const id = await addExpense(admin, 1000, null);
    await del(admin, id);
    for (const who of [admin, manager, vendeur, investor]) {
      const r = await tryAs(user(who), 'SELECT id FROM expenses WHERE id=$1', [id]);
      expect(r.rows).toEqual([]);
    }
    expect((await tryAs(ANON, 'SELECT id FROM expenses WHERE id=$1', [id])).rows ?? []).toEqual([]);
  });

  it('an app role cannot soft-delete or undelete with a raw UPDATE', async () => {
    const id = await addExpense(admin, 1000, null);
    const direct = await tryAs(user(admin), 'UPDATE expenses SET deleted_at = now() WHERE id=$1', [id]);
    // restrictive WITH CHECK (defaults to USING) rejects the new row
    expect(direct.error).toBeDefined();
    await del(admin, id);
    const un = await tryAs(user(admin), 'UPDATE expenses SET deleted_at = NULL WHERE id=$1 RETURNING id', [id]);
    expect(un.rows ?? []).toEqual([]);            // invisible row: matches nothing
    expect(Number((await q('SELECT COUNT(*)::int n FROM expenses WHERE id=$1 AND deleted_at IS NOT NULL', [id]))[0].n)).toBe(1);
  });

  it('vendeur still sees only their own live rows', async () => {
    const mine = await addExpense(vendeur, 1000, null, 'en_attente');
    const adminsRow = await addExpense(admin, 2000, null);
    const rows = (await tryAs(user(vendeur), 'SELECT id FROM expenses WHERE business_id=$1', [biz])).rows!;
    const ids = rows.map(r => r.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(adminsRow);
    await del(vendeur, mine);
    expect((await tryAs(user(vendeur), 'SELECT id FROM expenses WHERE id=$1', [mine])).rows).toEqual([]);
  });
});

// ── role gates ───────────────────────────────────────────────────────────────
describe('soft_delete_expense / restore_expense gates', () => {
  it('manager and administrateur can delete any expense', async () => {
    const a = await addExpense(admin, 1000, null);
    expect((await del(manager, a)).rows![0].ok).toBe(true);
    const b = await addExpense(vendeur, 1000, null, 'en_attente');
    expect((await del(admin, b)).rows![0].ok).toBe(true);
  });

  it('vendeur may only delete their own PENDING expense', async () => {
    const own = await addExpense(vendeur, 1000, null, 'en_attente');
    const ownApproved = await addExpense(vendeur, 1000, null, 'en_attente');
    await q(`UPDATE expenses SET status='approuve' WHERE id=$1`, [ownApproved]);
    const others = await addExpense(admin, 1000, null);
    expect((await del(vendeur, others)).error).toBeDefined();
    expect((await del(vendeur, ownApproved)).error).toBeDefined();
    expect((await del(vendeur, own)).rows![0].ok).toBe(true);
  });

  it('investisseur, outsider and anon cannot delete', async () => {
    const id = await addExpense(admin, 1000, null);
    expect((await del(investor, id)).error).toBeDefined();
    expect((await del(outsider, id)).error).toBeDefined();
    expect((await tryAs(ANON, 'SELECT soft_delete_expense($1)', [id])).error).toBeDefined();
    expect(Number((await q('SELECT COUNT(*)::int n FROM expenses WHERE id=$1 AND deleted_at IS NULL', [id]))[0].n)).toBe(1);
  });

  it('delete and restore are idempotent (outbox replay is harmless)', async () => {
    const id = await addExpense(admin, 1000, null);
    expect((await del(admin, id)).rows![0].ok).toBe(true);
    expect((await del(admin, id)).rows![0].ok).toBe(true);
    expect((await restore(admin, id)).rows![0].ok).toBe(true);
    expect((await restore(admin, id)).rows![0].ok).toBe(true);
    expect((await del(admin, randomUUID())).rows![0].ok).toBe(true);
  });

  it('only whoever deleted it can restore, and only within 24h', async () => {
    const id = await addExpense(admin, 1000, null);
    await del(admin, id);
    expect((await restore(manager, id)).error).toBeDefined();
    expect((await restore(outsider, id)).error).toBeDefined();
    await q(`UPDATE expenses SET deleted_at = now() - interval '25 hours' WHERE id=$1`, [id]);
    expect((await restore(admin, id)).error).toBeDefined();   // support restores older ones by hand
  });
});

// ── product link ─────────────────────────────────────────────────────────────
describe('product link is metadata only', () => {
  it('set, change, unlink; never touches stock', async () => {
    const stock = async (p: string) => Number((await q('SELECT stock_qty FROM products WHERE id=$1', [p]))[0].stock_qty);
    const [r0, o0] = [await stock(rice), await stock(oil)];
    const id = await addExpense(admin, 5000, rice);
    await tryAs(user(admin), 'UPDATE expenses SET product_id=$2 WHERE id=$1', [id, oil]);
    await tryAs(user(admin), 'UPDATE expenses SET product_id=NULL WHERE id=$1', [id]);
    expect([await stock(rice), await stock(oil)]).toEqual([r0, o0]);
    expect(Number((await q(`SELECT COUNT(*)::int n FROM stock_moves WHERE product_id IN ($1,$2)`, [rice, oil]))[0].n)).toBe(0);
  });

  it('deleting the product keeps the expense (ON DELETE SET NULL)', async () => {
    const p = await seedProduct(biz, admin, { name: 'À supprimer' });
    const id = await addExpense(admin, 4200, p);
    await q('DELETE FROM products WHERE id=$1', [p]);
    const row = (await q('SELECT product_id, amount FROM expenses WHERE id=$1', [id]))[0];
    expect(row.product_id).toBeNull();
    expect(Number(row.amount)).toBe(4200);
  });

  it('a soft-deleted expense with a product does not block deleting the product', async () => {
    const p = await seedProduct(biz, admin, { name: 'Autre' });
    const id = await addExpense(admin, 100, p);
    await del(admin, id);
    await q('DELETE FROM products WHERE id=$1', [p]);
    expect((await q('SELECT product_id FROM expenses WHERE id=$1', [id]))[0].product_id).toBeNull();
  });
});

describe('cross-business isolation', () => {
  it("another business's admin cannot delete or see this business's expenses", async () => {
    const id = await addExpense(admin, 1000, null);
    expect((await del(outsider, id)).error).toBeDefined();
    expect((await tryAs(user(outsider), 'SELECT id FROM expenses WHERE id=$1', [id])).rows).toEqual([]);
    void otherBiz;
  });
});
