// Security audit 2026-09-27 — last batch of the SECURITY DEFINER sweep
// (proof-attachment functions, lowest priority per the sweep's own
// stock/money-first ordering). Both functions take no separate
// p_business_id at all — they derive it from the target row by p_id alone
// and authorize against that derived value — so there's no
// independently-suppliable business_id to mismatch against. Still gets a
// live test rather than resting on that reading alone.
import { createTestUser, createTestBusiness, adminClient } from './helpers';

describe('attach_transaction_proof / delete_transaction_proof — cross-business id (confirmed safe)', () => {
  it("an admin of a different business cannot attach a proof to another business's capital injection", async () => {
    const { client: victimC, userId: victimUserId } = await createTestUser('victim');
    const victimBusinessId = await createTestBusiness(victimC, 'Boutique Victime');
    const { data: injectionId } = await victimC.rpc('record_injection', { p_business_id: victimBusinessId, p_amount: 50000 });

    const { client: attackerC } = await createTestUser('attacker');
    await createTestBusiness(attackerC, 'Boutique Attaquant');

    const { error } = await attackerC.rpc('attach_transaction_proof', {
      p_kind: 'apport', p_id: injectionId, p_image_url: 'https://example.com/fake.jpg',
    });
    expect(error).toBeTruthy();

    const admin = adminClient();
    const { data: injection } = await admin.from('capital_injections').select('proof_image_url').eq('id', injectionId).single();
    expect(injection!.proof_image_url).toBeNull();
  });

  it("an admin of a different business cannot delete another business's attached proof", async () => {
    const { client: victimC, userId: victimUserId } = await createTestUser('victim2');
    const victimBusinessId = await createTestBusiness(victimC, 'Boutique Victime 2');
    const { data: injectionId } = await victimC.rpc('record_injection', { p_business_id: victimBusinessId, p_amount: 50000 });
    const { error: attachErr } = await victimC.rpc('attach_transaction_proof', {
      p_kind: 'apport', p_id: injectionId, p_image_url: 'https://example.com/real.jpg',
    });
    expect(attachErr).toBeNull();

    const { client: attackerC } = await createTestUser('attacker2');
    await createTestBusiness(attackerC, 'Boutique Attaquant 2');

    const { error } = await attackerC.rpc('delete_transaction_proof', { p_kind: 'apport', p_id: injectionId });
    expect(error).toBeTruthy();

    const admin = adminClient();
    const { data: injection } = await admin.from('capital_injections').select('proof_image_url').eq('id', injectionId).single();
    expect(injection!.proof_image_url).toBe('https://example.com/real.jpg'); // untouched
  });
});
