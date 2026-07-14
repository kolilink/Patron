// Exercises the two real Postgres functions behind the "how did the shop
// do" afternoon push (db/migration_v139.sql):
//   - learn_digest_send_hours(): derives each business's digest_send_hour
//     from the last-sale hour of its trailing 14 days of sales (clamped to
//     16-21 UTC), falling back to a flat 17 for businesses without enough
//     signal (< 5 sale-days).
//   - get_and_mark_daily_digest_businesses(): finds businesses whose
//     learned hour is *now* and haven't been sent to yet today, computes
//     today's revenue, and marks them sent atomically so an overlapping
//     cron run can't double-send.
// Both are service_role-only (no client-facing policy), so sale rows and
// business state are written directly via the admin client rather than
// through submit_sale — this suite is about the digest RPCs' own logic,
// not sale creation (already covered by submit-sale.integration.test.ts).
import { randomUUID } from 'crypto';
import { adminClient, createTestUser, createTestBusiness } from './helpers';

const admin = adminClient();

function utcDateDaysAgo(days: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Inserts a real sale_orders row directly (bypasses submit_sale — only sale_date/created_at/status/total_amount matter here). */
async function insertSale(businessId: string, userId: string, overrides: {
  saleDate: Date; hourUtc?: number; totalAmount?: number; status?: string;
}): Promise<void> {
  const createdAt = new Date(overrides.saleDate);
  createdAt.setUTCHours(overrides.hourUtc ?? 12, 0, 0, 0);

  const { error } = await admin.from('sale_orders').insert({
    id: randomUUID(),
    business_id: businessId,
    seller_id: userId,
    created_by: userId,
    status: overrides.status ?? 'paye',
    total_amount: overrides.totalAmount ?? 150000, // 1500 in the currency's whole units, cents
    discount_amount: 0,
    sale_date: toDateString(overrides.saleDate),
    created_at: createdAt.toISOString(),
  });
  if (error) throw error;
}

describe('learn_digest_send_hours (real RPC)', () => {
  it('is not callable by a regular authenticated client — service_role only', async () => {
    const { client } = await createTestUser('digest-learn-perm');
    const { error } = await client.rpc('learn_digest_send_hours');
    expect(error).toBeTruthy();
  });

  it('defaults a business with zero sales to 17:00', async () => {
    const { client } = await createTestUser('digest-empty');
    const businessId = await createTestBusiness(client, 'Boutique Digest Empty');

    const { error } = await admin.rpc('learn_digest_send_hours');
    expect(error).toBeNull();

    const { data } = await admin.from('businesses').select('digest_send_hour').eq('id', businessId).single();
    expect(data!.digest_send_hour).toBe(17);
  });

  it('defaults a business with fewer than 5 sale-days to 17:00, even with a consistent late-hour pattern', async () => {
    const { client, userId } = await createTestUser('digest-sparse');
    const businessId = await createTestBusiness(client, 'Boutique Digest Sparse');

    for (let i = 0; i < 4; i++) {
      await insertSale(businessId, userId, { saleDate: utcDateDaysAgo(i + 1), hourUtc: 20 });
    }

    await admin.rpc('learn_digest_send_hours');
    const { data } = await admin.from('businesses').select('digest_send_hour').eq('id', businessId).single();
    expect(data!.digest_send_hour).toBe(17);
  });

  it('learns the send hour as 1h after the median last-sale hour, once 5+ sale-days exist', async () => {
    const { client, userId } = await createTestUser('digest-learned');
    const businessId = await createTestBusiness(client, 'Boutique Digest Learned');

    // 5 distinct days, each with its last sale at 17:00 UTC — median last-sale
    // hour is 17, so digest_send_hour should land at 18 (17 + 1), well within
    // the 16-21 clamp so there's no ambiguity about which bound fired.
    for (let i = 0; i < 5; i++) {
      const day = utcDateDaysAgo(i + 1);
      await insertSale(businessId, userId, { saleDate: day, hourUtc: 9 }); // an earlier sale same day
      await insertSale(businessId, userId, { saleDate: day, hourUtc: 17 }); // the day's last sale
    }

    await admin.rpc('learn_digest_send_hours');
    const { data } = await admin.from('businesses').select('digest_send_hour').eq('id', businessId).single();
    expect(data!.digest_send_hour).toBe(18);
  });

  it('clamps a very early last-sale pattern up to the 16:00 floor', async () => {
    const { client, userId } = await createTestUser('digest-clamp-low');
    const businessId = await createTestBusiness(client, 'Boutique Digest Clamp Low');

    for (let i = 0; i < 5; i++) {
      await insertSale(businessId, userId, { saleDate: utcDateDaysAgo(i + 1), hourUtc: 8 }); // +1 = 9, clamps to 16
    }

    await admin.rpc('learn_digest_send_hours');
    const { data } = await admin.from('businesses').select('digest_send_hour').eq('id', businessId).single();
    expect(data!.digest_send_hour).toBe(16);
  });

  it('clamps a very late last-sale pattern down to the 21:00 ceiling', async () => {
    const { client, userId } = await createTestUser('digest-clamp-high');
    const businessId = await createTestBusiness(client, 'Boutique Digest Clamp High');

    for (let i = 0; i < 5; i++) {
      await insertSale(businessId, userId, { saleDate: utcDateDaysAgo(i + 1), hourUtc: 23 }); // +1 = 24, clamps to 21
    }

    await admin.rpc('learn_digest_send_hours');
    const { data } = await admin.from('businesses').select('digest_send_hour').eq('id', businessId).single();
    expect(data!.digest_send_hour).toBe(21);
  });

  it('ignores sales older than the trailing 14-day window', async () => {
    const { client, userId } = await createTestUser('digest-stale');
    const businessId = await createTestBusiness(client, 'Boutique Digest Stale');

    for (let i = 0; i < 5; i++) {
      await insertSale(businessId, userId, { saleDate: utcDateDaysAgo(20 + i), hourUtc: 17 });
    }

    await admin.rpc('learn_digest_send_hours');
    const { data } = await admin.from('businesses').select('digest_send_hour').eq('id', businessId).single();
    // No sales inside the window → falls back to the zero-sales default, not the learned 18.
    expect(data!.digest_send_hour).toBe(17);
  });
});

describe('get_and_mark_daily_digest_businesses (real RPC)', () => {
  it('is not callable by a regular authenticated client — service_role only', async () => {
    const { client } = await createTestUser('digest-send-perm');
    const { error } = await client.rpc('get_and_mark_daily_digest_businesses');
    expect(error).toBeTruthy();
  });

  it('returns tier=bonne with the real revenue for a due business with sales today, and marks it sent', async () => {
    const { client, userId } = await createTestUser('digest-bonne');
    const businessId = await createTestBusiness(client, 'Boutique Digest Bonne');
    const nowHour = new Date().getUTCHours();

    await admin.from('businesses').update({ digest_send_hour: nowHour, digest_last_sent_date: null }).eq('id', businessId);
    await insertSale(businessId, userId, { saleDate: new Date(), totalAmount: 150000 });
    await insertSale(businessId, userId, { saleDate: new Date(), totalAmount: 50000 });

    const { data, error } = await admin.rpc('get_and_mark_daily_digest_businesses');
    expect(error).toBeNull();
    const row = (data as any[]).find((r) => r.business_id === businessId);
    expect(row).toMatchObject({ tier: 'bonne', revenue_cents: 200000, currency: 'GNF' });

    const { data: biz } = await admin.from('businesses').select('digest_last_sent_date').eq('id', businessId).single();
    expect(biz!.digest_last_sent_date).toBe(toDateString(new Date()));
  });

  it('returns tier=calme with revenue_cents=0 for a due business with zero sales today', async () => {
    const { client } = await createTestUser('digest-calme');
    const businessId = await createTestBusiness(client, 'Boutique Digest Calme');
    const nowHour = new Date().getUTCHours();

    await admin.from('businesses').update({ digest_send_hour: nowHour, digest_last_sent_date: null }).eq('id', businessId);

    const { data } = await admin.rpc('get_and_mark_daily_digest_businesses');
    const row = (data as any[]).find((r) => r.business_id === businessId);
    expect(row).toMatchObject({ tier: 'calme', revenue_cents: 0 });
  });

  it('excludes a business whose digest_send_hour is not the current hour', async () => {
    const { client } = await createTestUser('digest-wrong-hour');
    const businessId = await createTestBusiness(client, 'Boutique Digest Wrong Hour');
    const otherHour = (new Date().getUTCHours() + 5) % 24;

    await admin.from('businesses').update({ digest_send_hour: otherHour, digest_last_sent_date: null }).eq('id', businessId);

    const { data } = await admin.rpc('get_and_mark_daily_digest_businesses');
    expect((data as any[]).some((r) => r.business_id === businessId)).toBe(false);
  });

  it('does not double-send: a business already sent today is excluded even if the hour matches (regression guard for the atomicity this RPC was built for)', async () => {
    const { client } = await createTestUser('digest-dedupe');
    const businessId = await createTestBusiness(client, 'Boutique Digest Dedupe');
    const nowHour = new Date().getUTCHours();

    await admin.from('businesses').update({ digest_send_hour: nowHour, digest_last_sent_date: null }).eq('id', businessId);

    const first = await admin.rpc('get_and_mark_daily_digest_businesses');
    expect((first.data as any[]).some((r) => r.business_id === businessId)).toBe(true);

    const second = await admin.rpc('get_and_mark_daily_digest_businesses');
    expect((second.data as any[]).some((r) => r.business_id === businessId)).toBe(false);
  });

  it('sends again the next day once digest_last_sent_date is in the past', async () => {
    const { client } = await createTestUser('digest-next-day');
    const businessId = await createTestBusiness(client, 'Boutique Digest Next Day');
    const nowHour = new Date().getUTCHours();
    const yesterday = toDateString(utcDateDaysAgo(1));

    await admin.from('businesses').update({ digest_send_hour: nowHour, digest_last_sent_date: yesterday }).eq('id', businessId);

    const { data } = await admin.rpc('get_and_mark_daily_digest_businesses');
    expect((data as any[]).some((r) => r.business_id === businessId)).toBe(true);
  });

  it('excludes a cancelled sale from today\'s revenue', async () => {
    const { client, userId } = await createTestUser('digest-cancelled');
    const businessId = await createTestBusiness(client, 'Boutique Digest Cancelled');
    const nowHour = new Date().getUTCHours();

    await admin.from('businesses').update({ digest_send_hour: nowHour, digest_last_sent_date: null }).eq('id', businessId);
    await insertSale(businessId, userId, { saleDate: new Date(), totalAmount: 150000, status: 'annule' });

    const { data } = await admin.rpc('get_and_mark_daily_digest_businesses');
    const row = (data as any[]).find((r) => r.business_id === businessId);
    expect(row).toMatchObject({ tier: 'calme', revenue_cents: 0 });
  });
});
