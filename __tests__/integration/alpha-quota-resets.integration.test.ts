// Exercises the real get_and_mark_alpha_quota_resets() Postgres function
// (db/migration_v138.sql) — finds users whose fixed 24h Alpha quota window
// expired while they were still at their limit, and marks each as notified
// atomically so an overlapping cron run can't double-send. alpha_quota has
// no client-facing policy at all (not even SELECT — see migration_v133.sql),
// so every row here is written directly via the service-role admin client,
// mirroring how a real alpha_quota row only ever gets there through
// send_alpha_message() in production.
import { adminClient, createTestUser, createTestBusiness } from './helpers';

const admin = adminClient();

async function setAiAccess(businessId: string, access: 'none' | 'active'): Promise<void> {
  if (access === 'active') {
    await admin.from('businesses').update({ subscription_status: 'active' }).eq('id', businessId);
  } else {
    await admin.from('businesses').update({
      subscription_status: 'expired',
      trial_ends_at: new Date(Date.now() - 60_000).toISOString(),
    }).eq('id', businessId);
  }
}

/** Opens a real alpha_conversations row (the RPC resolves business_id/tier via the user's most recently active conversation). */
async function openConversation(businessId: string, userId: string): Promise<void> {
  const { error } = await admin.from('alpha_conversations').insert({
    business_id: businessId,
    user_id: userId,
    last_message_at: new Date().toISOString(),
  });
  if (error) throw error;
}

async function setQuota(userId: string, overrides: {
  windowStart: Date; countInWindow: number; resetNotifiedAt?: Date | null;
}): Promise<void> {
  const { error } = await admin.from('alpha_quota').upsert({
    user_id: userId,
    window_start: overrides.windowStart.toISOString(),
    count_in_window: overrides.countInWindow,
    reset_notified_at: overrides.resetNotifiedAt === undefined ? null : overrides.resetNotifiedAt?.toISOString() ?? null,
  });
  if (error) throw error;
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000);

describe('get_and_mark_alpha_quota_resets (real RPC)', () => {
  it('is not callable by a regular authenticated client — service_role only', async () => {
    const { client } = await createTestUser('quota-perm');
    const { error } = await client.rpc('get_and_mark_alpha_quota_resets');
    expect(error).toBeTruthy();
  });

  it('surfaces a free-tier user whose window expired while exhausted, and marks reset_notified_at', async () => {
    const { client, userId } = await createTestUser('quota-free');
    const businessId = await createTestBusiness(client, 'Boutique Quota Free');
    await setAiAccess(businessId, 'none');
    await openConversation(businessId, userId);
    await setQuota(userId, { windowStart: hoursAgo(25), countInWindow: 5 }); // free limit is 5 (v136)

    const { data, error } = await admin.rpc('get_and_mark_alpha_quota_resets');
    expect(error).toBeNull();
    const row = (data as any[]).find((r) => r.user_id === userId);
    expect(row).toMatchObject({ user_id: userId, business_id: businessId, tier: 'free' });

    const { data: quotaRow } = await admin.from('alpha_quota').select('reset_notified_at').eq('user_id', userId).single();
    expect(quotaRow!.reset_notified_at).not.toBeNull();
  });

  it('surfaces a paid-tier user at the 20-limit as tier=paid', async () => {
    const { client, userId } = await createTestUser('quota-paid');
    const businessId = await createTestBusiness(client, 'Boutique Quota Paid');
    await setAiAccess(businessId, 'active');
    await openConversation(businessId, userId);
    await setQuota(userId, { windowStart: hoursAgo(25), countInWindow: 20 }); // paid limit is 20 (v135)

    const { data } = await admin.rpc('get_and_mark_alpha_quota_resets');
    const row = (data as any[]).find((r) => r.user_id === userId);
    expect(row).toMatchObject({ tier: 'paid' });
  });

  it('does not double-send: a second call in the same window omits an already-marked user (regression guard for the atomicity this RPC was built for)', async () => {
    const { client, userId } = await createTestUser('quota-dedupe');
    const businessId = await createTestBusiness(client, 'Boutique Quota Dedupe');
    await setAiAccess(businessId, 'none');
    await openConversation(businessId, userId);
    await setQuota(userId, { windowStart: hoursAgo(25), countInWindow: 5 });

    const first = await admin.rpc('get_and_mark_alpha_quota_resets');
    expect((first.data as any[]).some((r) => r.user_id === userId)).toBe(true);

    const second = await admin.rpc('get_and_mark_alpha_quota_resets');
    expect((second.data as any[]).some((r) => r.user_id === userId)).toBe(false);
  });

  it('ignores a user whose window has not expired yet (< 24h old)', async () => {
    const { client, userId } = await createTestUser('quota-fresh');
    const businessId = await createTestBusiness(client, 'Boutique Quota Fresh');
    await setAiAccess(businessId, 'none');
    await openConversation(businessId, userId);
    await setQuota(userId, { windowStart: hoursAgo(1), countInWindow: 5 });

    const { data } = await admin.rpc('get_and_mark_alpha_quota_resets');
    expect((data as any[]).some((r) => r.user_id === userId)).toBe(false);
  });

  it('ignores a user whose window expired but was never actually exhausted', async () => {
    const { client, userId } = await createTestUser('quota-not-exhausted');
    const businessId = await createTestBusiness(client, 'Boutique Quota Not Exhausted');
    await setAiAccess(businessId, 'none');
    await openConversation(businessId, userId);
    await setQuota(userId, { windowStart: hoursAgo(25), countInWindow: 2 }); // well under the free limit of 5

    const { data } = await admin.rpc('get_and_mark_alpha_quota_resets');
    expect((data as any[]).some((r) => r.user_id === userId)).toBe(false);
  });

  it('notifies again for a fresh exhausted window after a prior reset was already notified', async () => {
    const { client, userId } = await createTestUser('quota-second-cycle');
    const businessId = await createTestBusiness(client, 'Boutique Quota Second Cycle');
    await setAiAccess(businessId, 'none');
    await openConversation(businessId, userId);

    // Simulates: notified for a previous exhausted window (reset_notified_at
    // predates the *current* window_start), then hit the limit again in a
    // brand new window that has itself since expired.
    await setQuota(userId, { windowStart: hoursAgo(25), countInWindow: 5, resetNotifiedAt: hoursAgo(50) });

    const { data } = await admin.rpc('get_and_mark_alpha_quota_resets');
    expect((data as any[]).some((r) => r.user_id === userId)).toBe(true);
  });
});
