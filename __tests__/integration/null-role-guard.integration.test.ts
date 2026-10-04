// NULL-unsafe authorization guards (migration_v225) — real RPCs, local Postgres.
//
// get_role(bid) is NULL for a caller with no membership, and auth.uid() is NULL
// for an unauthenticated caller. `IF NULL THEN RAISE` never raises, so guards
// written `get_role(x) NOT IN (...)` / `v_owner != auth.uid()` silently let
// non-members / anon callers through. Every test here asserts the SPECIFIC
// refusal message AND that the row is untouched — asserting only
// `error` truthy can pass for an unrelated reason (not-found, bad arg…).
import { randomUUID } from 'crypto';
import { createTestUser, createTestBusiness, adminClient, anonClient } from './helpers';

const REFUSED = /Accès refusé/;

async function world() {
  const { client: owner, userId: ownerId } = await createTestUser('owner');
  const businessId = await createTestBusiness(owner, 'Commerce Cible');
  // Authenticated user with NO membership in businessId (has their own business).
  const { client: outsider } = await createTestUser('outsider');
  await createTestBusiness(outsider, 'Autre Commerce');
  return { owner, ownerId, businessId, outsider, anon: anonClient() };
}

const callers = (w: Awaited<ReturnType<typeof world>>) =>
  [['non-member', w.outsider], ['anon', w.anon]] as const;

describe('NULL-safe role guards — non-member / anon callers are refused', () => {
  it('edit_withdrawal', async () => {
    const w = await world();
    const { data: id } = await w.owner.rpc('record_withdrawal', { p_business_id: w.businessId, p_amount: 100000 });
    for (const [label, c] of callers(w)) {
      const { error } = await c.rpc('edit_withdrawal', { p_id: id, p_amount: 1 });
      expect([label, error?.message]).toEqual([label, expect.stringMatching(REFUSED)]);
    }
    const { data: row } = await adminClient().from('capital_injections').select('amount, edited_at').eq('id', id).single();
    expect(row!.amount).toBe(-100000);
    expect(row!.edited_at).toBeNull();
  });

  it('edit_injection (already guarded — regression)', async () => {
    const w = await world();
    const { data: id } = await w.owner.rpc('record_injection', { p_business_id: w.businessId, p_amount: 50000 });
    for (const [label, c] of callers(w)) {
      const { error } = await c.rpc('edit_injection', { p_id: id, p_amount: 1 });
      expect([label, error?.message]).toEqual([label, expect.stringMatching(REFUSED)]);
    }
    const { data: row } = await adminClient().from('capital_injections').select('amount').eq('id', id).single();
    expect(row!.amount).toBe(50000);
  });

  it('record_withdrawal (already guarded — regression)', async () => {
    const w = await world();
    for (const [label, c] of callers(w)) {
      const { error } = await c.rpc('record_withdrawal', { p_business_id: w.businessId, p_amount: 5000 });
      expect([label, error?.message]).toEqual([label, expect.stringMatching(REFUSED)]);
    }
    const { count } = await adminClient().from('capital_injections').select('id', { count: 'exact', head: true }).eq('business_id', w.businessId);
    expect(count).toBe(0);
  });

  it('record_payment', async () => {
    const w = await world();
    for (const [label, c] of callers(w)) {
      const { error } = await c.rpc('record_payment', {
        p_sale_id: randomUUID(), p_business_id: w.businessId, p_amount: 1000, p_method: 'especes', p_date: '2026-01-01',
      });
      expect([label, error?.message]).toEqual([label, expect.stringMatching(REFUSED)]);
    }
  });

  it('void_payment', async () => {
    const w = await world();
    for (const [label, c] of callers(w)) {
      const { error } = await c.rpc('void_payment', { p_payment_id: randomUUID(), p_business_id: w.businessId });
      expect([label, error?.message]).toEqual([label, expect.stringMatching(REFUSED)]);
    }
  });

  it('void_purchase_order_receipt', async () => {
    const w = await world();
    for (const [label, c] of callers(w)) {
      const { error } = await c.rpc('void_purchase_order_receipt', { p_batch_id: randomUUID(), p_business_id: w.businessId });
      expect([label, error?.message]).toEqual([label, expect.stringMatching(REFUSED)]);
    }
  });

  it('attach_transaction_proof — apport (non-expense branch)', async () => {
    const w = await world();
    const { data: id } = await w.owner.rpc('record_injection', { p_business_id: w.businessId, p_amount: 50000 });
    for (const [label, c] of callers(w)) {
      const { error } = await c.rpc('attach_transaction_proof', { p_kind: 'apport', p_id: id, p_image_url: 'https://example.com/x.jpg' });
      expect([label, error?.message]).toEqual([label, expect.stringMatching(REFUSED)]);
    }
    const { data: row } = await adminClient().from('capital_injections').select('proof_image_url').eq('id', id).single();
    expect(row!.proof_image_url).toBeNull();
  });

  it('attach_transaction_proof — expense branch', async () => {
    const w = await world();
    const { data: exp, error: insErr } = await adminClient().from('expenses').insert({
      business_id: w.businessId, amount: 10000, description: 'Test', created_by: w.ownerId, status: 'en_attente',
    }).select('id').single();
    expect(insErr).toBeNull();
    for (const [label, c] of callers(w)) {
      const { error } = await c.rpc('attach_transaction_proof', { p_kind: 'expense', p_id: exp!.id, p_image_url: 'https://example.com/x.jpg' });
      expect([label, error?.message]).toEqual([label, expect.stringMatching(REFUSED)]);
    }
    const { data: row } = await adminClient().from('expenses').select('proof_image_url').eq('id', exp!.id).single();
    expect(row!.proof_image_url).toBeNull();
  });
});

describe('NULL-safe identity guards — anon (auth.uid() NULL) is refused', () => {
  it('delete_transaction_proof', async () => {
    const w = await world();
    const { data: id } = await w.owner.rpc('record_injection', { p_business_id: w.businessId, p_amount: 50000 });
    const { error: aErr } = await w.owner.rpc('attach_transaction_proof', { p_kind: 'apport', p_id: id, p_image_url: 'https://example.com/real.jpg' });
    expect(aErr).toBeNull();
    for (const [label, c] of callers(w)) {
      const { error } = await c.rpc('delete_transaction_proof', { p_kind: 'apport', p_id: id });
      expect([label, error?.message]).toEqual([label, expect.stringMatching(REFUSED)]);
    }
    const { data: row } = await adminClient().from('capital_injections').select('proof_image_url').eq('id', id).single();
    expect(row!.proof_image_url).toBe('https://example.com/real.jpg');
  });

  it('delete_market_post', async () => {
    const w = await world();
    const { data: post, error: pErr } = await adminClient().from('market_posts').insert({
      author_id: w.ownerId, author_name: 'Auteur', category: 'general', title: 'T', content: 'C',
    }).select('id').single();
    expect(pErr).toBeNull();
    for (const [label, c] of callers(w)) {
      const { error } = await c.rpc('delete_market_post', { p_post_id: post!.id });
      expect([label, error?.message]).toEqual([label, expect.stringMatching(/propres posts/)]);
    }
    const { data: still } = await adminClient().from('market_posts').select('id').eq('id', post!.id);
    expect(still).toHaveLength(1);
    // The author can still delete their own post.
    const { data: ok, error: ownErr } = await w.owner.rpc('delete_market_post', { p_post_id: post!.id });
    expect(ownErr).toBeNull();
    expect(ok).toBe(true);
  });

  it('mark_support_read + submit_support_rating', async () => {
    const w = await world();
    const { data: conv, error: cErr } = await adminClient().from('support_conversations').insert({
      business_id: w.businessId, merchant_user_id: w.ownerId,
    }).select('id').single();
    expect(cErr).toBeNull();
    for (const [label, c] of callers(w)) {
      const r1 = await c.rpc('mark_support_read', { p_conversation_id: conv!.id, p_as_founder: false });
      expect([label, r1.error?.message]).toEqual([label, expect.stringMatching(REFUSED)]);
      const r2 = await c.rpc('submit_support_rating', { p_conversation_id: conv!.id, p_rating: 1 });
      expect([label, r2.error?.message]).toEqual([label, expect.stringMatching(REFUSED)]);
    }
    const { data: row } = await adminClient().from('support_conversations').select('rating, merchant_last_read_at').eq('id', conv!.id).single();
    expect(row!.rating).toBeNull();
    // The conversation's owner still can.
    const { error: okErr } = await w.owner.rpc('submit_support_rating', { p_conversation_id: conv!.id, p_rating: 5 });
    expect(okErr).toBeNull();
  });
});
