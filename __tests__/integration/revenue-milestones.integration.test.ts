// Exercises the real get_and_mark_revenue_milestones() Postgres function
// (db/migration_v165.sql) — finds GNF businesses whose real lifetime
// revenue (SUM(total_amount - discount_amount), status IN ('paye','credit'))
// just crossed the next threshold in the ladder, fires once per threshold
// ever via a ratcheting businesses.highest_revenue_milestone_cents column.
import { randomUUID } from 'crypto';
import { adminClient, createTestUser, createTestBusiness } from './helpers';

const admin = adminClient();

async function insertSale(businessId: string, userId: string, totalCents: number, overrides: {
  status?: string; discountCents?: number;
} = {}): Promise<void> {
  const { error } = await admin.from('sale_orders').insert({
    id: randomUUID(),
    business_id: businessId,
    seller_id: userId,
    created_by: userId,
    status: overrides.status ?? 'paye',
    total_amount: totalCents,
    discount_amount: overrides.discountCents ?? 0,
    sale_date: new Date().toISOString().slice(0, 10),
  });
  if (error) throw error;
}

function resultFor(data: unknown, businessId: string): { business_id: string; milestone_cents: number } | undefined {
  return (data as { business_id: string; milestone_cents: number }[]).find(r => r.business_id === businessId);
}

const ONE_MILLION_GNF_CENTS = 100_000_000; // 1,000,000 GNF × 100

describe('get_and_mark_revenue_milestones (real RPC)', () => {
  it('is not callable by a regular authenticated client — service_role only', async () => {
    const { client } = await createTestUser('milestone-perm');
    const { error } = await client.rpc('get_and_mark_revenue_milestones');
    expect(error).toBeTruthy();
  });

  it('does not fire below the first threshold', async () => {
    const { client, userId } = await createTestUser('milestone-below');
    const businessId = await createTestBusiness(client, 'Boutique Milestone Below');
    await insertSale(businessId, userId, ONE_MILLION_GNF_CENTS - 100);

    const { data } = await admin.rpc('get_and_mark_revenue_milestones');
    expect(resultFor(data, businessId)).toBeUndefined();
  });

  it('fires the first threshold (1,000,000 GNF) the moment lifetime revenue crosses it, and ratchets the column', async () => {
    const { client, userId } = await createTestUser('milestone-first');
    const businessId = await createTestBusiness(client, 'Boutique Milestone First');
    await insertSale(businessId, userId, ONE_MILLION_GNF_CENTS);

    const { data } = await admin.rpc('get_and_mark_revenue_milestones');
    expect(resultFor(data, businessId)).toMatchObject({ milestone_cents: ONE_MILLION_GNF_CENTS });

    const { data: biz } = await admin.from('businesses').select('highest_revenue_milestone_cents').eq('id', businessId).single();
    expect(biz!.highest_revenue_milestone_cents).toBe(ONE_MILLION_GNF_CENTS);
  });

  it('does not re-fire the same threshold on a second call (regression guard for the ratchet)', async () => {
    const { client, userId } = await createTestUser('milestone-dedupe');
    const businessId = await createTestBusiness(client, 'Boutique Milestone Dedupe');
    await insertSale(businessId, userId, ONE_MILLION_GNF_CENTS);

    const first = await admin.rpc('get_and_mark_revenue_milestones');
    expect(resultFor(first.data, businessId)).toBeDefined();

    const second = await admin.rpc('get_and_mark_revenue_milestones');
    expect(resultFor(second.data, businessId)).toBeUndefined();
  });

  it('jumps straight to the highest threshold crossed, skipping intermediate ones, when revenue leaps past several at once', async () => {
    const { client, userId } = await createTestUser('milestone-jump');
    const businessId = await createTestBusiness(client, 'Boutique Milestone Jump');
    // One big sale straight past 1M and 5M, landing exactly on 10M —
    // should fire once, for 10M only, not three separate events.
    await insertSale(businessId, userId, 1_000_000_000); // 10,000,000 GNF

    const { data } = await admin.rpc('get_and_mark_revenue_milestones');
    const rows = (data as { business_id: string; milestone_cents: number }[]).filter(r => r.business_id === businessId);
    expect(rows).toHaveLength(1);
    expect(rows[0].milestone_cents).toBe(1_000_000_000);
  });

  it('fires the next threshold once revenue grows further, after already ratcheting past an earlier one', async () => {
    const { client, userId } = await createTestUser('milestone-next');
    const businessId = await createTestBusiness(client, 'Boutique Milestone Next');
    await insertSale(businessId, userId, ONE_MILLION_GNF_CENTS);
    await admin.rpc('get_and_mark_revenue_milestones'); // consumes the 1M milestone

    await insertSale(businessId, userId, 500_000_000 - ONE_MILLION_GNF_CENTS); // brings lifetime total to exactly 5,000,000 GNF

    const { data } = await admin.rpc('get_and_mark_revenue_milestones');
    expect(resultFor(data, businessId)).toMatchObject({ milestone_cents: 500_000_000 });
  });

  it('excludes a cancelled sale from lifetime revenue', async () => {
    const { client, userId } = await createTestUser('milestone-cancelled');
    const businessId = await createTestBusiness(client, 'Boutique Milestone Cancelled');
    await insertSale(businessId, userId, ONE_MILLION_GNF_CENTS, { status: 'annule' });

    const { data } = await admin.rpc('get_and_mark_revenue_milestones');
    expect(resultFor(data, businessId)).toBeUndefined();
  });

  it('counts a credit (debt) sale toward revenue, same as a cash sale', async () => {
    const { client, userId } = await createTestUser('milestone-credit');
    const businessId = await createTestBusiness(client, 'Boutique Milestone Credit');
    await insertSale(businessId, userId, ONE_MILLION_GNF_CENTS, { status: 'credit' });

    const { data } = await admin.rpc('get_and_mark_revenue_milestones');
    expect(resultFor(data, businessId)).toMatchObject({ milestone_cents: ONE_MILLION_GNF_CENTS });
  });

  it('nets out discount_amount before comparing against the ladder', async () => {
    const { client, userId } = await createTestUser('milestone-discount');
    const businessId = await createTestBusiness(client, 'Boutique Milestone Discount');
    // Gross total is above 1M, but net of discount it falls just short.
    await insertSale(businessId, userId, ONE_MILLION_GNF_CENTS + 50_000, { discountCents: 100_000 });

    const { data } = await admin.rpc('get_and_mark_revenue_milestones');
    expect(resultFor(data, businessId)).toBeUndefined();
  });

  it('ignores a non-GNF business entirely, regardless of revenue', async () => {
    const { client, userId } = await createTestUser('milestone-nongnf');
    const businessId = await createTestBusiness(client, 'Boutique Milestone NonGNF');
    await admin.from('businesses').update({ currency: 'XOF' }).eq('id', businessId);
    await insertSale(businessId, userId, ONE_MILLION_GNF_CENTS * 10);

    const { data } = await admin.rpc('get_and_mark_revenue_milestones');
    expect(resultFor(data, businessId)).toBeUndefined();
  });
});
