// Exercises the real join_business() Postgres function — expiry, max-uses,
// manager-limit, duplicate-membership, and rate-limit enforcement all live
// in this one SQL function and are easy to silently break with an unrelated
// edit (see migration_v46/v53 fix history in CLAUDE.md).
import {
  createTestUser, createTestBusiness, addMember, createInviteCode,
} from './helpers';

describe('join_business (real RPC)', () => {
  it('joins successfully with a valid code and creates the membership with the invited role', async () => {
    const { client: adminC, userId: adminId } = await createTestUser('admin');
    const businessId = await createTestBusiness(adminC, 'Boutique Test');
    const code = await createInviteCode(businessId, adminId, { role: 'vendeur' });

    const { client: joinerC } = await createTestUser('joiner');
    const { data, error } = await joinerC.rpc('join_business', { p_code: code });

    expect(error).toBeNull();
    expect(data).toMatchObject({ business_id: businessId, role: 'vendeur' });
  });

  it('rejects an expired code with the specific French expiry message (regression: v46)', async () => {
    const { client: adminC, userId: adminId } = await createTestUser('admin');
    const businessId = await createTestBusiness(adminC, 'Boutique Test');
    const code = await createInviteCode(businessId, adminId, {
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });

    const { client: joinerC } = await createTestUser('joiner');
    const { error } = await joinerC.rpc('join_business', { p_code: code });

    expect(error).toBeTruthy();
    expect(error!.message).toMatch(/a expiré/);
  });

  it('rejects a code that has already reached max_uses (regression: v46)', async () => {
    const { client: adminC, userId: adminId } = await createTestUser('admin');
    const businessId = await createTestBusiness(adminC, 'Boutique Test');
    const code = await createInviteCode(businessId, adminId, { max_uses: 1, uses: 1 });

    const { client: joinerC } = await createTestUser('joiner');
    const { error } = await joinerC.rpc('join_business', { p_code: code });

    expect(error).toBeTruthy();
    expect(error!.message).toMatch(/déjà été utilisé/);
  });

  it('rejects a second manager when the business already has one', async () => {
    const { client: adminC, userId: adminId } = await createTestUser('admin');
    const businessId = await createTestBusiness(adminC, 'Boutique Test');

    const { userId: existingManagerId } = await createTestUser('manager1');
    await addMember(businessId, existingManagerId, 'manager');

    const code = await createInviteCode(businessId, adminId, { role: 'manager' });
    const { client: joinerC } = await createTestUser('manager2');
    const { error } = await joinerC.rpc('join_business', { p_code: code });

    expect(error).toBeTruthy();
    expect(error!.message).toMatch(/déjà un gérant/);
  });

  // Regression test for a real bug this suite found: join_business's INSERT
  // INTO invite_attempts happened *before* the expiry/max-uses/manager/
  // duplicate checks, clearly intending every one of those failures to
  // still count against the 5-per-10-min rate limit. But a Postgres
  // function invoked by a single top-level statement is atomic — when
  // join_business RAISEd on one of those checks, the entire call rolled
  // back, including the invite_attempts row it had just inserted. Net
  // effect: only successful joins ever actually got logged; guessing wrong/
  // expired/already-claimed codes never tripped the limiter no matter how
  // many times it was retried. Fixed in migration_v124 by splitting attempt
  // logging into its own record_invite_attempt() RPC, which the client now
  // calls as a separate round trip immediately before join_business() (see
  // stores/auth.ts) — its own top-level statement always commits
  // regardless of whether the join itself succeeds.
  it('enforces the 5-attempts-per-10-minutes rate limit, without counting invalid-code lookups (regression: v53, v124)', async () => {
    const { client: adminC, userId: adminId } = await createTestUser('admin');
    const businessId = await createTestBusiness(adminC, 'Boutique Test');
    const code = await createInviteCode(businessId, adminId, { role: 'vendeur' });

    const { client: joinerC } = await createTestUser('joiner');

    // Call 1: succeeds and consumes the code. record_invite_attempt commits
    // (count=1) before join_business's own rate-limit check runs, so that
    // check already sees this round's own attempt.
    await joinerC.rpc('record_invite_attempt');
    const first = await joinerC.rpc('join_business', { p_code: code });
    expect(first.error).toBeNull();

    // Calls 2-4: same code, now a duplicate-membership error each time —
    // these count against the rate limit (the code itself is valid/found).
    // Attempt count reaches 2, 3, 4 respectively, all still under 5.
    for (let i = 0; i < 3; i++) {
      await joinerC.rpc('record_invite_attempt');
      const { error } = await joinerC.rpc('join_business', { p_code: code });
      expect(error).toBeTruthy();
      expect(error!.message).toMatch(/déjà membre/);
    }

    // Call 5: record_invite_attempt brings the count to 5, so
    // join_business's own check (which now sees this round's freshly
    // committed row) trips the rate limit before even looking at the code.
    await joinerC.rpc('record_invite_attempt');
    const fifth = await joinerC.rpc('join_business', { p_code: code });
    expect(fifth.error).toBeTruthy();
    expect(fifth.error!.message).toMatch(/Trop de tentatives/);
  });
});
