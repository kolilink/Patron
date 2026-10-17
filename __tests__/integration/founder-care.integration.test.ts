// migration_v247 — founder care plan RPCs. LOCAL TEST DB ONLY. Run alone:
//   npx jest --config jest.integration.config.js founder-care --runInBand
import { as, tryAs, seedUser, seedBusiness, user, ANON } from './pgrole';
import { assertLocalDb, becomeFounder, resignFounder, lockFounder, unlockFounder, q } from './pg';

beforeAll(() => assertLocalDb());

let founder: string;
const phone = () => `+224${Math.floor(600000000 + Math.random() * 99999999)}`;

async function realMerchant(label: string, bizName: string) {
  const id = await seedUser(label);
  await q(`UPDATE profiles SET phone = $2 WHERE id = $1`, [id, phone()]);
  const biz = await seedBusiness(id, bizName);
  return { id, biz };
}

const state = async () =>
  (await as(user(founder), c => c.query(`SELECT get_founder_care_state() AS s`))).rows[0].s as any[];

beforeAll(async () => {
  await lockFounder();
  founder = await seedUser('founder');
  await becomeFounder(founder);
});
afterAll(async () => {
  await resignFounder(founder);
  await unlockFounder();
});

describe('founder care plan', () => {
  it('refuses merchants and anon; table is unreachable', async () => {
    const m = await realMerchant('care-m', 'Boutique A');
    for (const sql of [
      `SELECT get_founder_care_state()`,
      `SELECT mark_founder_care_contact('${m.biz}', 'j0')`,
    ]) {
      const r = await tryAs(user(m.id), sql);
      expect(r.error?.code).toBe('P0001');
      expect((await tryAs(ANON, sql)).error?.code).toBe('42501');
    }
    expect((await tryAs(user(founder), `SELECT * FROM founder_care_contacts`)).error?.code).toBe('42501');
  });

  it('marks idempotently, validates the step, and reports sales vs credits (7 days)', async () => {
    const m = await realMerchant('care-b', 'Boutique B');
    // as(..., commit = true): tryAs rolls back, and this write must persist.
    const mark = async (step: string) => {
      try {
        await as(user(founder), c => c.query(`SELECT mark_founder_care_contact($1, $2) AS r`, [m.biz, step]), true);
        return { error: undefined as { message: string } | undefined };
      } catch (e: any) {
        return { error: { message: e.message as string } };
      }
    };

    const first = await mark('j0');
    expect(first.error).toBeFalsy();
    const t1 = (await q(`SELECT contacted_at FROM founder_care_contacts WHERE business_id = $1 AND step = 'j0'`, [m.biz]))[0].contacted_at;
    await mark('j0');
    const rows = await q(`SELECT contacted_at FROM founder_care_contacts WHERE business_id = $1`, [m.biz]);
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0].contacted_at).getTime()).toBe(new Date(t1).getTime());

    expect((await mark('nope')).error?.message).toMatch(/Étape invalide/);
    expect((await tryAs(user(founder), `SELECT mark_founder_care_contact('00000000-0000-0000-0000-000000000000','j0')`)).error?.message)
      .toMatch(/Commerce introuvable/);

    const ins = (status: string, isCredit: boolean, ago: string) =>
      q(`INSERT INTO sale_orders (business_id, seller_id, created_by, status, total_amount, discount_amount, sale_date, paid_at, is_credit, created_at)
         VALUES ($1,$2,$2,$3,100000,0,CURRENT_DATE, now(), $4, now() - $5::interval)`, [m.biz, m.id, status, isCredit, ago]);
    await ins('paye', false, '1 day');
    await ins('paye', false, '2 days');
    await ins('credit', true, '1 day');
    await ins('paye', true, '3 days'); // a credit already repaid is still a credit
    await ins('paye', false, '20 days'); // outside the window
    await ins('annule', false, '1 day'); // cancelled never counts

    const mine = (await state()).find(r => r.business_id === m.biz);
    expect(mine.sales_7d).toBe(2);
    expect(mine.credits_7d).toBe(2);
    expect(mine.contacts.map((c: any) => c.step)).toEqual(['j0']);
  });

  it('excludes test and demo businesses', async () => {
    const t = await realMerchant('care-t', 'Boutique test');
    await q(`UPDATE businesses SET is_test = true WHERE id = $1`, [t.biz]);
    const demoOwner = await seedUser('care-demo');
    const demoBiz = await seedBusiness(demoOwner, 'Boutique Démo');
    const ids = (await state()).map(r => r.business_id);
    expect(ids).not.toContain(t.biz);
    expect(ids).not.toContain(demoBiz);
  });
});
