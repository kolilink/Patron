// Exercises the real increment_unread_notifications() Postgres function
// (db/migration_v137.sql) — dispatch-notification calls this once per
// recipient to get an accurate running badge count (Apple/Android stamp the
// exact number the payload sends, they don't accumulate it themselves), so
// this function is the only place that number is allowed to change server-side.
import { randomUUID } from 'crypto';
import { adminClient, createTestUser } from './helpers';

const admin = adminClient();

describe('increment_unread_notifications (real RPC)', () => {
  it('is not callable by a regular authenticated client — service_role only', async () => {
    const { client, userId } = await createTestUser('badge-perm');
    const { error } = await client.rpc('increment_unread_notifications', { p_user_ids: [userId] });
    expect(error).toBeTruthy();
  });

  it('starts a fresh profile at 0 and increments to 1 on the first call', async () => {
    const { userId } = await createTestUser('badge-fresh');

    const { data: before } = await admin.from('profiles').select('unread_notification_count').eq('id', userId).single();
    expect(before!.unread_notification_count).toBe(0);

    const { data, error } = await admin.rpc('increment_unread_notifications', { p_user_ids: [userId] });
    expect(error).toBeNull();
    expect(data).toEqual([{ id: userId, unread_notification_count: 1 }]);
  });

  it('accumulates across repeated calls instead of resetting (the exact bug this migration fixed — a flat badge: 1 on every push)', async () => {
    const { userId } = await createTestUser('badge-accumulate');

    for (let i = 1; i <= 3; i++) {
      const { data } = await admin.rpc('increment_unread_notifications', { p_user_ids: [userId] });
      expect((data as any[])[0].unread_notification_count).toBe(i);
    }
  });

  it('increments every recipient in a batch call, each independently', async () => {
    const { userId: userA } = await createTestUser('badge-batch-a');
    const { userId: userB } = await createTestUser('badge-batch-b');

    // userA already has one unread; userB is fresh.
    await admin.rpc('increment_unread_notifications', { p_user_ids: [userA] });

    const { data } = await admin.rpc('increment_unread_notifications', { p_user_ids: [userA, userB] });
    const byId = Object.fromEntries((data as any[]).map((r) => [r.id, r.unread_notification_count]));
    expect(byId[userA]).toBe(2);
    expect(byId[userB]).toBe(1);
  });

  it('silently ignores a non-existent user id instead of erroring', async () => {
    const { userId } = await createTestUser('badge-mixed');
    const bogusId = randomUUID();

    const { data, error } = await admin.rpc('increment_unread_notifications', { p_user_ids: [userId, bogusId] });
    expect(error).toBeNull();
    expect((data as any[]).map((r) => r.id)).toEqual([userId]);
  });

  it('resets to 0 via the same plain profile update the client uses on app open, unaffected by this RPC', async () => {
    const { userId } = await createTestUser('badge-reset');

    await admin.rpc('increment_unread_notifications', { p_user_ids: [userId] });
    await admin.rpc('increment_unread_notifications', { p_user_ids: [userId] });

    const { error } = await admin.from('profiles').update({ unread_notification_count: 0 }).eq('id', userId);
    expect(error).toBeNull();

    const { data } = await admin.from('profiles').select('unread_notification_count').eq('id', userId).single();
    expect(data!.unread_notification_count).toBe(0);
  });
});
