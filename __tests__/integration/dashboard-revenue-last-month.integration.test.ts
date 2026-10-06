// migration_v240 — get_dashboard_kpis().revenue_last_month. LOCAL TEST DB ONLY.
// Fixed p_today so month boundaries are exact: "this month" = Oct 2026, "last month" = Sep 2026.
import { randomUUID } from 'crypto';
import { assertLocalDb, q } from './pg';
import { as, user, seedUser, seedBusiness, seedMember } from './pgrole';

beforeAll(() => assertLocalDb());

const TODAY = '2026-10-15';

async function sale(biz: string, seller: string, o: { paidAt: string; total: number; discount?: number; status?: string }) {
  await q(
    `INSERT INTO sale_orders (id, business_id, seller_id, created_by, status, total_amount, discount_amount, sale_date, paid_at, is_credit)
     VALUES ($1,$2,$3,$3,$4,$5,$6,$7::timestamptz::date,$7::timestamptz,$8)`,
    [randomUUID(), biz, seller, o.status ?? 'paye', o.total, o.discount ?? 0, o.paidAt, (o.status ?? 'paye') === 'credit']);
}

const kpis = async (who: string, biz: string) =>
  (await as(user(who), c => c.query(`SELECT get_dashboard_kpis($1, $2::date) AS k`, [biz, TODAY]))).rows[0].k;

describe('get_dashboard_kpis — revenue_last_month', () => {
  it('sums paid sales in [start of last month, start of this month), net of discount, and nothing else', async () => {
    const owner = await seedUser('owner');
    const biz = await seedBusiness(owner, 'Deux mois');

    await sale(biz, owner, { paidAt: '2026-09-10 10:00+00', total: 500000 });                      // last month
    await sale(biz, owner, { paidAt: '2026-09-30 23:59:59+00', total: 100000 });                   // last month, last second
    await sale(biz, owner, { paidAt: '2026-09-01 00:00:00+00', total: 50000, discount: 5000 });    // first instant of last month, net 45 000
    await sale(biz, owner, { paidAt: '2026-10-01 00:00:00+00', total: 200000 });                   // THIS month (boundary)
    await sale(biz, owner, { paidAt: '2026-10-10 12:00+00', total: 70000 });                       // this month
    await sale(biz, owner, { paidAt: '2026-08-31 23:59:59+00', total: 999999 });                   // two months ago: excluded
    await sale(biz, owner, { paidAt: '2026-09-12 10:00+00', total: 777777, status: 'credit' });    // not paid: excluded
    await sale(biz, owner, { paidAt: '2026-09-13 10:00+00', total: 888888, status: 'annule' });    // cancelled: excluded

    const k = await kpis(owner, biz);
    expect(Number(k.revenue_last_month)).toBe(500000 + 100000 + 45000);
    expect(Number(k.revenue_month)).toBe(200000 + 70000);   // existing key unchanged
  });

  it('is 0 (never missing) when last month had no paid sales', async () => {
    const owner = await seedUser('owner2');
    const biz = await seedBusiness(owner, 'Premier mois');
    await sale(biz, owner, { paidAt: '2026-10-05 09:00+00', total: 123456 });
    const k = await kpis(owner, biz);
    expect(Number(k.revenue_last_month)).toBe(0);
    expect(Number(k.revenue_month)).toBe(123456);
  });

  it('a vendeur sees only their own last-month sales; the owner sees everyone\'s', async () => {
    const owner = await seedUser('owner3'); const vend = await seedUser('vend3');
    const biz = await seedBusiness(owner, 'Équipe');
    await seedMember(biz, vend, 'vendeur');
    await sale(biz, owner, { paidAt: '2026-09-10 10:00+00', total: 400000 });
    await sale(biz, vend, { paidAt: '2026-09-11 10:00+00', total: 90000 });
    expect(Number((await kpis(owner, biz)).revenue_last_month)).toBe(490000);
    expect(Number((await kpis(vend, biz)).revenue_last_month)).toBe(90000);
  });

  it('a January call looks back into December of the previous year', async () => {
    const owner = await seedUser('owner4');
    const biz = await seedBusiness(owner, 'Janvier');
    await sale(biz, owner, { paidAt: '2025-12-20 10:00+00', total: 300000 });
    const k = (await as(user(owner), c => c.query(`SELECT get_dashboard_kpis($1, '2026-01-10'::date) AS k`, [biz]))).rows[0].k;
    expect(Number(k.revenue_last_month)).toBe(300000);
  });
});
