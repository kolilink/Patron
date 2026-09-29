// Exercises get_and_mark_activation_nudges() (db/migration_v155.sql), the
// real engine behind activation_nudge_1, activation_nudge_2, and
// second_action_reminder. "Signup" is businesses.created_at; a "capture" is
// a real sale_orders row (not brouillon/annule) or a products row. Tests
// backdate businesses.created_at / sale_orders.created_at / products.created_at
// directly via the admin client to simulate elapsed time without waiting.
import { randomUUID } from 'crypto';
import { adminClient, createTestUser, createTestBusiness } from './helpers';

const admin = adminClient();

function hoursAgo(h: number): Date {
  return new Date(Date.now() - h * 60 * 60 * 1000);
}

async function backdateBusiness(businessId: string, createdAt: Date): Promise<void> {
  const { error } = await admin.from('businesses').update({ created_at: createdAt.toISOString() }).eq('id', businessId);
  if (error) throw error;
}

async function insertSale(businessId: string, userId: string, createdAt: Date, status: 'paye' | 'credit' = 'paye'): Promise<void> {
  const { error } = await admin.from('sale_orders').insert({
    id: randomUUID(),
    business_id: businessId,
    seller_id: userId,
    created_by: userId,
    status,
    total_amount: 100000,
    sale_date: createdAt.toISOString().slice(0, 10),
    created_at: createdAt.toISOString(),
  });
  if (error) throw error;
}

async function insertProduct(businessId: string, userId: string, createdAt: Date): Promise<void> {
  const { error } = await admin.from('products').insert({
    id: randomUUID(),
    business_id: businessId,
    name: `Produit ${randomUUID().slice(0, 6)}`,
    created_by: userId,
    created_at: createdAt.toISOString(),
  });
  if (error) throw error;
}

function rowFor(data: unknown, businessId: string, eventType: string) {
  return (data as any[]).find((r) => r.business_id === businessId && r.event_type === eventType);
}

describe('get_and_mark_activation_nudges (real RPC)', () => {
  it('is not callable by a regular authenticated client — service_role only', async () => {
    const { client } = await createTestUser('activation-perm');
    const { error } = await client.rpc('get_and_mark_activation_nudges');
    expect(error).toBeTruthy();
  });

  it('activation_nudge_1: fires for a business 5h old with zero captures, targets its creator', async () => {
    const { client, userId } = await createTestUser('activation-nudge1');
    const businessId = await createTestBusiness(client, 'Boutique Nudge1');
    await backdateBusiness(businessId, hoursAgo(5));

    const { data, error } = await admin.rpc('get_and_mark_activation_nudges');
    expect(error).toBeNull();
    const row = rowFor(data, businessId, 'activation_nudge_1');
    expect(row).toMatchObject({ business_id: businessId, user_id: userId, event_type: 'activation_nudge_1' });
  });

  it('activation_nudge_1 does not fire outside the 4-6h window', async () => {
    const { client } = await createTestUser('activation-nudge1-early');
    const businessId = await createTestBusiness(client, 'Boutique Nudge1 Early');
    await backdateBusiness(businessId, hoursAgo(2));

    const { data } = await admin.rpc('get_and_mark_activation_nudges');
    expect(rowFor(data, businessId, 'activation_nudge_1')).toBeUndefined();
  });

  it('activation_nudge_1 does not fire once a capture exists', async () => {
    const { client, userId } = await createTestUser('activation-nudge1-captured');
    const businessId = await createTestBusiness(client, 'Boutique Nudge1 Captured');
    await backdateBusiness(businessId, hoursAgo(5));
    await insertProduct(businessId, userId, hoursAgo(4));

    const { data } = await admin.rpc('get_and_mark_activation_nudges');
    expect(rowFor(data, businessId, 'activation_nudge_1')).toBeUndefined();
  });

  it('does not double-send: a second call for the same business/event returns nothing (atomic mark)', async () => {
    const { client } = await createTestUser('activation-nudge1-dedupe');
    const businessId = await createTestBusiness(client, 'Boutique Nudge1 Dedupe');
    await backdateBusiness(businessId, hoursAgo(5));

    const first = await admin.rpc('get_and_mark_activation_nudges');
    expect(rowFor(first.data, businessId, 'activation_nudge_1')).toBeDefined();

    const second = await admin.rpc('get_and_mark_activation_nudges');
    expect(rowFor(second.data, businessId, 'activation_nudge_1')).toBeUndefined();
  });

  it('activation_nudge_2: fires for a business >=24h old with zero captures', async () => {
    const { client, userId } = await createTestUser('activation-nudge2');
    const businessId = await createTestBusiness(client, 'Boutique Nudge2');
    await backdateBusiness(businessId, hoursAgo(25));

    const { data } = await admin.rpc('get_and_mark_activation_nudges');
    expect(rowFor(data, businessId, 'activation_nudge_2')).toMatchObject({ user_id: userId });
  });

  it('activation_nudge_2 does not fire once a capture exists', async () => {
    const { client, userId } = await createTestUser('activation-nudge2-captured');
    const businessId = await createTestBusiness(client, 'Boutique Nudge2 Captured');
    await backdateBusiness(businessId, hoursAgo(25));
    await insertSale(businessId, userId, hoursAgo(10));

    const { data } = await admin.rpc('get_and_mark_activation_nudges');
    expect(rowFor(data, businessId, 'activation_nudge_2')).toBeUndefined();
  });

  it('retires permanently after 7 days: neither nudge fires for a zero-capture business older than 7 days', async () => {
    const { client } = await createTestUser('activation-retired');
    const businessId = await createTestBusiness(client, 'Boutique Retired');
    await backdateBusiness(businessId, hoursAgo(24 * 8));

    const { data } = await admin.rpc('get_and_mark_activation_nudges');
    expect(rowFor(data, businessId, 'activation_nudge_1')).toBeUndefined();
    expect(rowFor(data, businessId, 'activation_nudge_2')).toBeUndefined();
  });

  it('second_action_reminder: fires 24h after a first capture (product) with no second capture, action_type=product', async () => {
    const { client, userId } = await createTestUser('activation-second-product');
    const businessId = await createTestBusiness(client, 'Boutique Second Product');
    await backdateBusiness(businessId, hoursAgo(48));
    await insertProduct(businessId, userId, hoursAgo(30));

    const { data } = await admin.rpc('get_and_mark_activation_nudges');
    expect(rowFor(data, businessId, 'second_action_reminder')).toMatchObject({ user_id: userId, action_type: 'product' });
  });

  it('second_action_reminder: action_type=debt when the first capture was a credit sale', async () => {
    const { client, userId } = await createTestUser('activation-second-debt');
    const businessId = await createTestBusiness(client, 'Boutique Second Debt');
    await backdateBusiness(businessId, hoursAgo(48));
    await insertSale(businessId, userId, hoursAgo(30), 'credit');

    const { data } = await admin.rpc('get_and_mark_activation_nudges');
    expect(rowFor(data, businessId, 'second_action_reminder')).toMatchObject({ action_type: 'debt' });
  });

  it('second_action_reminder: action_type=sale when the first capture was a regular sale', async () => {
    const { client, userId } = await createTestUser('activation-second-sale');
    const businessId = await createTestBusiness(client, 'Boutique Second Sale');
    await backdateBusiness(businessId, hoursAgo(48));
    await insertSale(businessId, userId, hoursAgo(30), 'paye');

    const { data } = await admin.rpc('get_and_mark_activation_nudges');
    expect(rowFor(data, businessId, 'second_action_reminder')).toMatchObject({ action_type: 'sale' });
  });

  it('second_action_reminder does not fire before 24h since the first capture', async () => {
    const { client, userId } = await createTestUser('activation-second-early');
    const businessId = await createTestBusiness(client, 'Boutique Second Early');
    await backdateBusiness(businessId, hoursAgo(10));
    await insertProduct(businessId, userId, hoursAgo(5));

    const { data } = await admin.rpc('get_and_mark_activation_nudges');
    expect(rowFor(data, businessId, 'second_action_reminder')).toBeUndefined();
  });

  it('second_action_reminder does not fire once a second capture exists', async () => {
    const { client, userId } = await createTestUser('activation-second-done');
    const businessId = await createTestBusiness(client, 'Boutique Second Done');
    await backdateBusiness(businessId, hoursAgo(48));
    await insertProduct(businessId, userId, hoursAgo(30));
    await insertSale(businessId, userId, hoursAgo(10));

    const { data } = await admin.rpc('get_and_mark_activation_nudges');
    expect(rowFor(data, businessId, 'second_action_reminder')).toBeUndefined();
  });
});
