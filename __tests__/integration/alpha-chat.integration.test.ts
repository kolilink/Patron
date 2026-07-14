// Exercises the real send_alpha_message/open_or_get_alpha_conversation/
// get_alpha_quota_status Postgres functions (db/migration_v133.sql, renamed
// from mystic_*/Mystic to alpha_*/Alpha by db/migration_v134.sql) — the
// welcome burst, the rolling-24h quota (3 free / 100 paid), and the RLS
// isolation between two users' conversations in the same business. Does
// NOT call the real Groq API (alpha-chat edge function) — no CI network
// dependency, doesn't burn the shared Groq budget, matches the existing
// precedent that no integration test hits Groq via generate-support-draft
// either.
import {
  adminClient, createTestUser, createTestBusiness, addMember,
} from './helpers';

async function setAiAccess(businessId: string, access: 'none' | 'active'): Promise<void> {
  const admin = adminClient();
  if (access === 'active') {
    await admin.from('businesses').update({ subscription_status: 'active' }).eq('id', businessId);
  } else {
    await admin.from('businesses').update({
      subscription_status: 'expired',
      trial_ends_at: new Date(Date.now() - 60_000).toISOString(),
    }).eq('id', businessId);
  }
}

describe('Alpha (real RPCs)', () => {
  it('open_or_get_alpha_conversation is idempotent — one row per (business, user)', async () => {
    const { client } = await createTestUser('alpha-admin');
    const businessId = await createTestBusiness(client, 'Boutique Alpha');
    await setAiAccess(businessId, 'none');

    const first = await client.rpc('open_or_get_alpha_conversation', { p_business_id: businessId });
    const second = await client.rpc('open_or_get_alpha_conversation', { p_business_id: businessId });

    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(first.data.id).toBe(second.data.id);
  });

  it('allows the welcome burst (10 messages) with no AI access and never touches the quota table', async () => {
    const { client, userId } = await createTestUser('alpha-burst');
    const businessId = await createTestBusiness(client, 'Boutique Burst');
    await setAiAccess(businessId, 'none');

    for (let i = 0; i < 10; i++) {
      const { error } = await client.rpc('send_alpha_message', { p_business_id: businessId, p_content: `Question ${i}` });
      expect(error).toBeNull();
    }

    const admin = adminClient();
    const { data: quotaRow } = await admin.from('alpha_quota').select('count_in_window').eq('user_id', userId).maybeSingle();
    expect(quotaRow).toBeNull();
  });

  it('enforces the 3-per-24h free ration after the welcome burst, and rejects the 4th without incrementing further', async () => {
    const { client, userId } = await createTestUser('alpha-free');
    const businessId = await createTestBusiness(client, 'Boutique Free');
    await setAiAccess(businessId, 'none');

    for (let i = 0; i < 10; i++) {
      await client.rpc('send_alpha_message', { p_business_id: businessId, p_content: `Burst ${i}` });
    }

    for (let i = 0; i < 3; i++) {
      const { error } = await client.rpc('send_alpha_message', { p_business_id: businessId, p_content: `Free ${i}` });
      expect(error).toBeNull();
    }

    const fourth = await client.rpc('send_alpha_message', { p_business_id: businessId, p_content: 'Free 4' });
    expect(fourth.error).toBeTruthy();
    expect(fourth.error!.message).toMatch(/Limite de questions atteinte/);

    const admin = adminClient();
    const { data: quotaRow } = await admin.from('alpha_quota').select('count_in_window').eq('user_id', userId).single();
    // Rejected call rolled back its own increment attempt (Postgres functions
    // are atomic per top-level call) — count stays at 3, not 4.
    expect(quotaRow!.count_in_window).toBe(3);
  });

  it('raises the ceiling to 100/24h once the business has active AI access', async () => {
    const { client } = await createTestUser('alpha-paid');
    const businessId = await createTestBusiness(client, 'Boutique Paid');
    await setAiAccess(businessId, 'active');

    for (let i = 0; i < 10; i++) {
      await client.rpc('send_alpha_message', { p_business_id: businessId, p_content: `Burst ${i}` });
    }

    // 4 more messages (would already have failed on the free tier's 3-cap) should succeed.
    for (let i = 0; i < 4; i++) {
      const { error } = await client.rpc('send_alpha_message', { p_business_id: businessId, p_content: `Paid ${i}` });
      expect(error).toBeNull();
    }

    const { data: status } = await client.rpc('get_alpha_quota_status', { p_business_id: businessId });
    expect(status.has_ai_access).toBe(true);
    expect(status.limit).toBe(100);
  });

  it('gives an administrateur and a vendeur separate conversations, invisible to each other via RLS', async () => {
    const { client: adminC } = await createTestUser('alpha-owner');
    const businessId = await createTestBusiness(adminC, 'Boutique Roles');
    await setAiAccess(businessId, 'none');

    const { client: vendeurC, userId: vendeurId } = await createTestUser('alpha-vendeur');
    await addMember(businessId, vendeurId, 'vendeur');

    const { data: adminConv } = await adminC.rpc('open_or_get_alpha_conversation', { p_business_id: businessId });
    const { data: vendeurConv } = await vendeurC.rpc('open_or_get_alpha_conversation', { p_business_id: businessId });
    expect(adminConv.id).not.toBe(vendeurConv.id);

    await adminC.rpc('send_alpha_message', { p_business_id: businessId, p_content: 'Question admin confidentielle' });

    // The vendeur's own client (not the service key) querying the admin's
    // conversation must come back empty — RLS-blocked, not just app-side unqueried.
    const { data: leaked } = await vendeurC.from('alpha_messages').select('*').eq('conversation_id', adminConv.id);
    expect(leaked ?? []).toHaveLength(0);
  });
});
