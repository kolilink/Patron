// decide_expense (migration_v244): a contested approve/reject refuses loudly
// against the CURRENT server state. LOCAL TEST DB ONLY (pg-role harness).
import { randomUUID } from 'crypto';
import { as, seedUser, seedBusiness, seedMember, user } from './pgrole';
import { assertLocalDb } from './pg';

beforeAll(() => assertLocalDb());

async function tryAs(who: any, sql: string, params: any[] = []): Promise<{ rows?: any[]; error?: { code?: string; message: string } }> {
  try {
    return { rows: await as(who, async c => (await c.query(sql, params)).rows, true) };
  } catch (e: any) {
    return { error: { code: e.code, message: e.message } };
  }
}

let admin: string, manager: string, vendeur: string, biz: string;

beforeAll(async () => {
  admin = await seedUser('admin');
  manager = await seedUser('manager');
  vendeur = await seedUser('vendeur');
  biz = await seedBusiness(admin, 'Commerce décisions');
  await seedMember(biz, manager, 'manager');
  await seedMember(biz, vendeur, 'vendeur');
});

async function pending(): Promise<string> {
  const id = randomUUID();
  const r = await tryAs(user(vendeur),
    `INSERT INTO expenses (id, business_id, amount, description, date, status, created_by)
     VALUES ($1,$2,5000,'Transport',CURRENT_DATE,'en_attente',$3)`, [id, biz, vendeur]);
  expect(r.error).toBeUndefined();
  return id;
}
const decide = (who: string, id: string, status: string) =>
  tryAs(user(who), 'SELECT decide_expense($1,$2) AS ok', [id, status]);
const statusOf = async (id: string) =>
  (await tryAs(user(admin), 'SELECT status, approved_by FROM expenses WHERE id=$1', [id])).rows![0];

describe('decide_expense', () => {
  it('approves a pending expense and stamps the decider', async () => {
    const id = await pending();
    expect((await decide(admin, id, 'approuve')).rows![0].ok).toBe(true);
    expect(await statusOf(id)).toEqual({ status: 'approuve', approved_by: admin });
  });

  it('approve then reject: the second is refused and names the decider', async () => {
    const id = await pending();
    await decide(admin, id, 'approuve');
    const r = await decide(manager, id, 'rejete');
    expect(r.error?.code).toBe('P0001');
    expect(r.error?.message).toMatch(/déjà été approuvée par/);
    expect((await statusOf(id)).status).toBe('approuve');
  });

  it('the same decision replayed is a harmless success, not a second write', async () => {
    const id = await pending();
    await decide(admin, id, 'approuve');
    expect((await decide(manager, id, 'approuve')).rows![0].ok).toBe(true);
    expect((await statusOf(id)).approved_by).toBe(admin);
  });

  it('refuses a soft-deleted expense', async () => {
    const id = await pending();
    await tryAs(user(admin), 'SELECT soft_delete_expense($1)', [id]);
    const r = await decide(admin, id, 'approuve');
    expect(r.error?.code).toBe('P0001');
    expect(r.error?.message).toMatch(/supprimée/);
  });

  it('refuses a vendeur and an unknown status', async () => {
    const id = await pending();
    expect((await decide(vendeur, id, 'approuve')).error?.code).toBe('P0001');
    expect((await decide(admin, id, 'paye')).error?.code).toBe('P0001');
    expect((await statusOf(id)).status).toBe('en_attente');
  });
});
