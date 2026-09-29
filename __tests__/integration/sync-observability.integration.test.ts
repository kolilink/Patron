// §9 of the offline-first rewrite (migration_v204): log_sync_lag (§9b) and
// get_business_sync_staleness (§9a). Verified against a real local
// Postgres instance.
//
// get_business_sync_staleness is founder-gated the same way every other
// founder-only RPC in this schema is (is_founder(), a global profiles.phone
// match against a real, specific number hardcoded in that function's own
// body). This file deliberately does NOT attempt to exercise the
// founder-success path — doing so would require putting that real phone
// number into a test file, which isn't appropriate even for a local test
// database. What's actually security-relevant and worth verifying here is
// that a NON-founder caller is rejected, which needs no such number at all.
import { createTestUser, createTestBusiness } from './helpers';

describe('log_sync_lag (§9b, real RPC)', () => {
  it('a member can log a lag entry, and lag_seconds is computed correctly from queued_at', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');

    const queuedAt = new Date(Date.now() - 45_000).toISOString(); // 45s ago
    const { error } = await client.rpc('log_sync_lag', {
      p_business_id: businessId,
      p_operation: 'submit_carnet_debt',
      p_queued_at: queuedAt,
    });
    expect(error).toBeNull();

    // Read back via a direct query as the same authenticated user would
    // never be able to (no client-facing SELECT policy) — using the
    // service-role-equivalent path only to VERIFY what was written, same
    // posture as every other test in this suite that checks server state
    // via adminClient().
    const { adminClient } = await import('./helpers');
    const admin = adminClient();
    const { data, error: readErr } = await admin
      .from('sync_lag_log')
      .select('business_id, operation, lag_seconds')
      .eq('business_id', businessId)
      .single();
    expect(readErr).toBeNull();
    expect(data!.operation).toBe('submit_carnet_debt');
    // Real elapsed time in the test run adds a little on top of the exact
    // 45s — a generous but real bound, not an exact-equality assertion
    // that would be flaky.
    expect(data!.lag_seconds).toBeGreaterThanOrEqual(44);
    expect(data!.lag_seconds).toBeLessThan(60);
    void userId;
  });

  it('rejects a caller who is not a member of the target business', async () => {
    const owner = await createTestUser('owner');
    const businessId = await createTestBusiness(owner.client, 'Boutique Test');
    const stranger = await createTestUser('stranger');

    const { error } = await stranger.client.rpc('log_sync_lag', {
      p_business_id: businessId,
      p_operation: 'submit_sale',
      p_queued_at: new Date().toISOString(),
    });
    expect(error).not.toBeNull();
  });
});

describe('get_business_sync_staleness (§9a, real RPC) — access control only', () => {
  it('rejects a non-founder caller outright, before returning any data', async () => {
    const { client } = await createTestUser('regular-member');
    const { error, data } = await client.rpc('get_business_sync_staleness');
    expect(error).not.toBeNull();
    expect(data).toBeNull();
  });
});
