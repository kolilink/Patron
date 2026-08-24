// Exercises the real get_and_mark_activation_reminders() Postgres function
// (db/migration_v161.sql) — finds businesses still within their first 24h
// that have neither a product nor a non-cancelled sale, and are due for the
// ~2h "nudge 1" and/or ~20h "nudge 2" activation push, marking each sent
// atomically so an overlapping cron run can't double-send. Mirrors
// alpha-quota-resets.integration.test.ts's shape — same class of RPC, same
// "backdate state directly via the admin client, since production only
// ever reaches this state through real elapsed time" posture.
import { randomUUID } from 'crypto';
import { adminClient, createTestUser, createTestBusiness } from './helpers';

const admin = adminClient();

const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000);

async function backdateBusiness(businessId: string, createdAt: Date): Promise<void> {
  const { error } = await admin.from('businesses').update({ created_at: createdAt.toISOString() }).eq('id', businessId);
  if (error) throw error;
}

async function insertProduct(businessId: string, userId: string): Promise<void> {
  const { error } = await admin.from('products').insert({
    id: randomUUID(),
    business_id: businessId,
    name: 'Produit Test',
    created_by: userId,
  });
  if (error) throw error;
}

async function insertSale(businessId: string, userId: string, status: string = 'paye'): Promise<void> {
  const { error } = await admin.from('sale_orders').insert({
    id: randomUUID(),
    business_id: businessId,
    seller_id: userId,
    created_by: userId,
    status,
    total_amount: 150000,
    discount_amount: 0,
    sale_date: new Date().toISOString().slice(0, 10),
  });
  if (error) throw error;
}

function nudgesFor(data: unknown, businessId: string): number[] {
  return (data as { business_id: string; nudge: number }[])
    .filter(r => r.business_id === businessId)
    .map(r => r.nudge)
    .sort();
}

describe('get_and_mark_activation_reminders (real RPC)', () => {
  it('is not callable by a regular authenticated client — service_role only', async () => {
    const { client } = await createTestUser('activation-perm');
    const { error } = await client.rpc('get_and_mark_activation_reminders');
    expect(error).toBeTruthy();
  });

  it('is not due at all for a brand-new business (0h old)', async () => {
    const { client } = await createTestUser('activation-fresh');
    const businessId = await createTestBusiness(client, 'Boutique Activation Fresh');

    const { data, error } = await admin.rpc('get_and_mark_activation_reminders');
    expect(error).toBeNull();
    expect(nudgesFor(data, businessId)).toEqual([]);
  });

  it('is due for nudge 1 only once past the 2h threshold, and marks activation_nudge_1_sent_at', async () => {
    const { client } = await createTestUser('activation-nudge1');
    const businessId = await createTestBusiness(client, 'Boutique Activation Nudge1');
    await backdateBusiness(businessId, hoursAgo(3));

    const { data } = await admin.rpc('get_and_mark_activation_reminders');
    expect(nudgesFor(data, businessId)).toEqual([1]);

    const { data: biz } = await admin.from('businesses')
      .select('activation_nudge_1_sent_at, activation_nudge_2_sent_at').eq('id', businessId).single();
    expect(biz!.activation_nudge_1_sent_at).not.toBeNull();
    expect(biz!.activation_nudge_2_sent_at).toBeNull();
  });

  it('does not double-send nudge 1 on a second call (regression guard for the atomicity this RPC was built for)', async () => {
    const { client } = await createTestUser('activation-dedupe');
    const businessId = await createTestBusiness(client, 'Boutique Activation Dedupe');
    await backdateBusiness(businessId, hoursAgo(3));

    const first = await admin.rpc('get_and_mark_activation_reminders');
    expect(nudgesFor(first.data, businessId)).toEqual([1]);

    const second = await admin.rpc('get_and_mark_activation_reminders');
    expect(nudgesFor(second.data, businessId)).toEqual([]);
  });

  it('returns both nudge 1 and nudge 2 in the same call for a business old enough for both, if neither was ever sent', async () => {
    const { client } = await createTestUser('activation-both');
    const businessId = await createTestBusiness(client, 'Boutique Activation Both');
    await backdateBusiness(businessId, hoursAgo(21));

    const { data } = await admin.rpc('get_and_mark_activation_reminders');
    expect(nudgesFor(data, businessId)).toEqual([1, 2]);
  });

  it('excludes a business that already has a product, regardless of age', async () => {
    const { client, userId } = await createTestUser('activation-has-product');
    const businessId = await createTestBusiness(client, 'Boutique Activation Has Product');
    await backdateBusiness(businessId, hoursAgo(21));
    await insertProduct(businessId, userId);

    const { data } = await admin.rpc('get_and_mark_activation_reminders');
    expect(nudgesFor(data, businessId)).toEqual([]);
  });

  it('excludes a business that already has a non-cancelled sale', async () => {
    const { client, userId } = await createTestUser('activation-has-sale');
    const businessId = await createTestBusiness(client, 'Boutique Activation Has Sale');
    await backdateBusiness(businessId, hoursAgo(21));
    await insertSale(businessId, userId, 'credit'); // a carnet debt is a credit sale under the hood

    const { data } = await admin.rpc('get_and_mark_activation_reminders');
    expect(nudgesFor(data, businessId)).toEqual([]);
  });

  it('does NOT count a cancelled sale as activation — still due', async () => {
    const { client, userId } = await createTestUser('activation-cancelled-sale');
    const businessId = await createTestBusiness(client, 'Boutique Activation Cancelled Sale');
    await backdateBusiness(businessId, hoursAgo(3));
    await insertSale(businessId, userId, 'annule');

    const { data } = await admin.rpc('get_and_mark_activation_reminders');
    expect(nudgesFor(data, businessId)).toEqual([1]);
  });

  it('excludes a business past 24h old even if a nudge was never sent (fork has already stopped appearing)', async () => {
    const { client } = await createTestUser('activation-too-old');
    const businessId = await createTestBusiness(client, 'Boutique Activation Too Old');
    await backdateBusiness(businessId, hoursAgo(30));

    const { data } = await admin.rpc('get_and_mark_activation_reminders');
    expect(nudgesFor(data, businessId)).toEqual([]);
  });
});
