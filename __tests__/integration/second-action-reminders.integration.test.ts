// Exercises the real get_and_mark_second_action_reminders() Postgres
// function (db/migration_v163.sql) — finds businesses that took exactly
// one of the three activation actions (product, sale, or debt) and went
// quiet, classifying which type it was.
//
// The classification logic is sale-first, product-fallback specifically to
// sidestep two real side effects found by tracing the actual RPCs before
// writing the query: submit_carnet_debt() creates a hidden is_system
// product alongside the credit sale_orders row, and "Vente rapide" creates
// a REAL, visible product alongside the cash sale_orders row. Both cases
// are exercised directly below (not just the simple single-row cases)
// since that's exactly the class of thing a live test catches that code
// review doesn't — see activation-reminders.integration.test.ts's own
// two-CTE bug for the precedent.
import { randomUUID } from 'crypto';
import { adminClient, createTestUser, createTestBusiness } from './helpers';

const admin = adminClient();

const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000);
const daysAgo = (d: number) => hoursAgo(d * 24);

async function insertProduct(businessId: string, userId: string, overrides: {
  isSystem?: boolean; createdAt?: Date;
} = {}): Promise<string> {
  const id = randomUUID();
  const { error } = await admin.from('products').insert({
    id,
    business_id: businessId,
    name: overrides.isSystem ? 'Solde reporté' : 'Produit Test',
    is_system: overrides.isSystem ?? false,
    created_by: userId,
    created_at: (overrides.createdAt ?? new Date()).toISOString(),
  });
  if (error) throw error;
  return id;
}

async function insertSale(businessId: string, userId: string, overrides: {
  status?: string; createdAt?: Date;
} = {}): Promise<string> {
  const id = randomUUID();
  const { error } = await admin.from('sale_orders').insert({
    id,
    business_id: businessId,
    seller_id: userId,
    created_by: userId,
    status: overrides.status ?? 'paye',
    total_amount: 150000,
    discount_amount: 0,
    sale_date: new Date().toISOString().slice(0, 10),
    created_at: (overrides.createdAt ?? new Date()).toISOString(),
  });
  if (error) throw error;
  return id;
}

function resultFor(data: unknown, businessId: string): { business_id: string; action_type: string } | undefined {
  return (data as { business_id: string; action_type: string }[]).find(r => r.business_id === businessId);
}

describe('get_and_mark_second_action_reminders (real RPC)', () => {
  it('is not callable by a regular authenticated client — service_role only', async () => {
    const { client } = await createTestUser('second-action-perm');
    const { error } = await client.rpc('get_and_mark_second_action_reminders');
    expect(error).toBeTruthy();
  });

  it('ignores a business with zero actions at all', async () => {
    const { client } = await createTestUser('second-action-none');
    const businessId = await createTestBusiness(client, 'Boutique Second Action None');

    const { data } = await admin.rpc('get_and_mark_second_action_reminders');
    expect(resultFor(data, businessId)).toBeUndefined();
  });

  it('classifies a lone real product (no sale at all) as product, past the 48h default threshold', async () => {
    const { client, userId } = await createTestUser('second-action-product');
    const businessId = await createTestBusiness(client, 'Boutique Second Action Product');
    await insertProduct(businessId, userId, { createdAt: hoursAgo(50) });

    const { data } = await admin.rpc('get_and_mark_second_action_reminders');
    expect(resultFor(data, businessId)).toMatchObject({ action_type: 'product' });

    const { data: biz } = await admin.from('businesses').select('second_action_nudge_sent_at').eq('id', businessId).single();
    expect(biz!.second_action_nudge_sent_at).not.toBeNull();
  });

  it('classifies a lone cash sale as sale', async () => {
    const { client, userId } = await createTestUser('second-action-sale');
    const businessId = await createTestBusiness(client, 'Boutique Second Action Sale');
    await insertSale(businessId, userId, { status: 'paye', createdAt: hoursAgo(50) });

    const { data } = await admin.rpc('get_and_mark_second_action_reminders');
    expect(resultFor(data, businessId)).toMatchObject({ action_type: 'sale' });
  });

  it('classifies a lone credit sale as debt', async () => {
    const { client, userId } = await createTestUser('second-action-debt-plain');
    const businessId = await createTestBusiness(client, 'Boutique Second Action Debt Plain');
    await insertSale(businessId, userId, { status: 'credit', createdAt: hoursAgo(50) });

    const { data } = await admin.rpc('get_and_mark_second_action_reminders');
    expect(resultFor(data, businessId)).toMatchObject({ action_type: 'debt' });
  });

  it('a real submit_carnet_debt-shaped row (credit sale + hidden is_system product) is still classified as debt, not excluded as "two actions"', async () => {
    const { client, userId } = await createTestUser('second-action-debt-realistic');
    const businessId = await createTestBusiness(client, 'Boutique Second Action Debt Realistic');
    // Mirrors exactly what submit_carnet_debt() itself writes: a hidden
    // is_system "Solde reporté" product alongside the credit sale.
    await insertProduct(businessId, userId, { isSystem: true, createdAt: hoursAgo(50) });
    await insertSale(businessId, userId, { status: 'credit', createdAt: hoursAgo(50) });

    const { data } = await admin.rpc('get_and_mark_second_action_reminders');
    expect(resultFor(data, businessId)).toMatchObject({ action_type: 'debt' });
  });

  it('a real "Vente rapide"-shaped row (cash sale + a REAL cloned product) is still classified as sale, not excluded as "two actions"', async () => {
    const { client, userId } = await createTestUser('second-action-sale-realistic');
    const businessId = await createTestBusiness(client, 'Boutique Second Action Sale Realistic');
    // Mirrors vente-rapide.tsx: createProduct() runs before submitSale(),
    // so a real (non-system) product exists alongside the cash sale.
    await insertProduct(businessId, userId, { isSystem: false, createdAt: hoursAgo(50) });
    await insertSale(businessId, userId, { status: 'paye', createdAt: hoursAgo(50) });

    const { data } = await admin.rpc('get_and_mark_second_action_reminders');
    expect(resultFor(data, businessId)).toMatchObject({ action_type: 'sale' });
  });

  it('excludes a business with two independent real actions (a product AND a separately-made sale)', async () => {
    const { client, userId } = await createTestUser('second-action-two');
    const businessId = await createTestBusiness(client, 'Boutique Second Action Two');
    await insertProduct(businessId, userId, { createdAt: hoursAgo(60) });
    await insertSale(businessId, userId, { status: 'paye', createdAt: hoursAgo(50) });
    // Two real products AND a sale — sale_count=1 but product_count=2,
    // clearly more than "one action" by any reading.
    await insertProduct(businessId, userId, { createdAt: hoursAgo(40) });

    const { data } = await admin.rpc('get_and_mark_second_action_reminders');
    expect(resultFor(data, businessId)).toBeUndefined();
  });

  it('does not fire before the minimum hours threshold', async () => {
    const { client, userId } = await createTestUser('second-action-tooearly');
    const businessId = await createTestBusiness(client, 'Boutique Second Action Too Early');
    await insertProduct(businessId, userId, { createdAt: hoursAgo(10) }); // default min is 48h

    const { data } = await admin.rpc('get_and_mark_second_action_reminders');
    expect(resultFor(data, businessId)).toBeUndefined();
  });

  it('does not fire past the maximum days threshold', async () => {
    const { client, userId } = await createTestUser('second-action-toolate');
    const businessId = await createTestBusiness(client, 'Boutique Second Action Too Late');
    await insertProduct(businessId, userId, { createdAt: daysAgo(20) }); // default max is 14 days

    const { data } = await admin.rpc('get_and_mark_second_action_reminders');
    expect(resultFor(data, businessId)).toBeUndefined();
  });

  it('does not double-send (regression guard for the atomicity this RPC was built for)', async () => {
    const { client, userId } = await createTestUser('second-action-dedupe');
    const businessId = await createTestBusiness(client, 'Boutique Second Action Dedupe');
    await insertProduct(businessId, userId, { createdAt: hoursAgo(50) });

    const first = await admin.rpc('get_and_mark_second_action_reminders');
    expect(resultFor(first.data, businessId)).toBeDefined();

    const second = await admin.rpc('get_and_mark_second_action_reminders');
    expect(resultFor(second.data, businessId)).toBeUndefined();
  });
});
