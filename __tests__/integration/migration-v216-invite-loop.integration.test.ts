// E2E FIX BATCH B — invite loop (migration_v216). TEST DB only — do not commit.
//
// Exercises the three server-side redefinitions against a real local Postgres:
//
//   B1 — list_my_consumer_friends() is now bidirectional: after a joiner
//        redeems the inviter's invite, the INVITER finally sees the joiner
//        in their Amis (leg b), not just the joiner seeing the inviter (leg a).
//   B3 — resolve_consumer_invite() returns `newly_used`: a fresh redemption
//        is true; an idempotent re-fire on the same device is false, so the
//        client can clear the pending token without re-pushing the inviter.
//   B4 — send_partnership_request() re-arms a declined partnership after a
//        7-day cooldown: a decline newer than 7 days raises; a stale decline
//        is deleted and a fresh pending request inserted.
//
// Run against a real local Postgres:
//   npx jest --config jest.integration.config.js migration-v216-invite-loop --runInBand

import { adminClient, createTestUser, createTestBusiness } from './helpers';

const admin = adminClient();

interface CreatedInvite { id: string; token: string; code: string; expires_at: string }
interface ResolvedInvite { inviter_id: string; inviter_name: string; newly_used: boolean }
interface FriendRow { id: string; friend_id: string; friend_name: string; invited_at: string }

describe('B1 — list_my_consumer_friends is bidirectional (migration_v216)', () => {
    it('the inviter sees the joiner in Amis after redemption', async () => {
        const inviter = await createTestUser('b1-inviter');
        await createTestBusiness(inviter.client, 'Boutique invitante');

        const joiner = await createTestUser('b1-joiner');
        await createTestBusiness(joiner.client, 'Boutique rejointe');

        const { data: created, error: createErr } = await inviter.client.rpc('create_consumer_invite');
        expect(createErr).toBeNull();
        const invite = created as CreatedInvite;

        // Joiner redeems the inviter's token.
        const { data: resolved, error: resolveErr } = await joiner.client.rpc('resolve_consumer_invite', {
            p_token: invite.token,
            p_code: '',
        });
        expect(resolveErr).toBeNull();
        expect((resolved as ResolvedInvite).inviter_id).toBe(inviter.userId);
        expect((resolved as ResolvedInvite).newly_used).toBe(true);

        // leg (a) — the joiner sees the inviter.
        const { data: joinerFriends } = await joiner.client.rpc('list_my_consumer_friends');
        expect((joinerFriends as FriendRow[]).map(f => f.friend_id)).toContain(inviter.userId);

        // leg (b) — the B1 fix: the inviter sees the joiner.
        const { data: inviterFriends, error: friendsErr } = await inviter.client.rpc('list_my_consumer_friends');
        expect(friendsErr).toBeNull();
        expect((inviterFriends as FriendRow[]).map(f => f.friend_id)).toContain(joiner.userId);
    });
});

describe('B3 — resolve_consumer_invite returns newly_used (migration_v216)', () => {
    it('fresh redemption is newly_used=true, re-fire is newly_used=false', async () => {
        const inviter = await createTestUser('b3-inviter');
        await createTestBusiness(inviter.client, 'Boutique b3');

        const joiner = await createTestUser('b3-joiner');
        await createTestBusiness(joiner.client, 'Boutique b3 jointe');

        const { data: created } = await inviter.client.rpc('create_consumer_invite');
        const invite = created as CreatedInvite;

        const first = await joiner.client.rpc('resolve_consumer_invite', {
            p_token: invite.token,
            p_code: '',
        });
        expect(first.error).toBeNull();
        expect((first.data as ResolvedInvite).newly_used).toBe(true);

        // Same device re-fires the deep link: idempotent, not an error, and it
        // must NOT re-signal a new friendship (newly_used=false).
        const second = await joiner.client.rpc('resolve_consumer_invite', {
            p_token: invite.token,
            p_code: '',
        });
        expect(second.error).toBeNull();
        expect((second.data as ResolvedInvite).newly_used).toBe(false);
        expect((second.data as ResolvedInvite).inviter_id).toBe(inviter.userId);

        // And the friendship is still counted exactly once.
        const { data: friends } = await joiner.client.rpc('list_my_consumer_friends');
        const rows = (friends as FriendRow[]).filter(f => f.friend_id === inviter.userId);
        expect(rows).toHaveLength(1);
    });
});

describe('B4 — declined partnership re-arms after a 7-day cooldown (migration_v216)', () => {
    it('a fresh decline blocks an immediate re-request with a cooldown error', async () => {
        const recipient = await createTestUser('b4-recipient');
        const businessA = await createTestBusiness(recipient.client, 'Boutique A');

        const requester = await createTestUser('b4-requester');
        const businessB = await createTestBusiness(requester.client, 'Boutique B');

        // Recipient (A) issues an invite code; requester (B) sends a request.
        const { data: codeA } = await recipient.client.rpc('get_or_create_invite_code', {
            p_business_id: businessA,
        });
        const sent = await requester.client.rpc('send_partnership_request', {
            p_invite_code: codeA,
            p_my_business_id: businessB,
        });
        expect(sent.error).toBeNull();
        const partnershipId = sent.data as string;

        // A declines.
        const declined = await recipient.client.rpc('decline_partnership_request', {
            p_partnership_id: partnershipId,
            p_my_business_id: businessA,
        });
        expect(declined.error).toBeNull();

        // B immediately re-requests with a fresh code: cooldown blocks it.
        const { data: codeA2 } = await recipient.client.rpc('get_or_create_invite_code', {
            p_business_id: businessA,
        });
        const reSent = await requester.client.rpc('send_partnership_request', {
            p_invite_code: codeA2,
            p_my_business_id: businessB,
        });
        expect(reSent.error).toBeTruthy();
        expect(reSent.error!.message).toMatch(/7 jours/);
    });

    it('a decline older than 7 days is deleted and a fresh request succeeds', async () => {
        const recipient = await createTestUser('b4-recipient2');
        const businessA = await createTestBusiness(recipient.client, 'Boutique A2');

        const requester = await createTestUser('b4-requester2');
        const businessB = await createTestBusiness(requester.client, 'Boutique B2');

        const { data: codeA } = await recipient.client.rpc('get_or_create_invite_code', {
            p_business_id: businessA,
        });
        const sent = await requester.client.rpc('send_partnership_request', {
            p_invite_code: codeA,
            p_my_business_id: businessB,
        });
        expect(sent.error).toBeNull();
        const partnershipId = sent.data as string;

        await recipient.client.rpc('decline_partnership_request', {
            p_partnership_id: partnershipId,
            p_my_business_id: businessA,
        });

        // Backdate the decline beyond the 7-day cooldown.
        const { error: backdateErr } = await admin
            .from('business_partnerships')
            .update({ updated_at: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString() })
            .eq('id', partnershipId);
        expect(backdateErr).toBeNull();

        // Re-request with a fresh code now succeeds.
        const { data: codeA2 } = await recipient.client.rpc('get_or_create_invite_code', {
            p_business_id: businessA,
        });
        const reSent = await requester.client.rpc('send_partnership_request', {
            p_invite_code: codeA2,
            p_my_business_id: businessB,
        });
        expect(reSent.error).toBeNull();

        const { data: row } = await admin
            .from('business_partnerships')
            .select('status')
            .eq('id', reSent.data as string)
            .single();
        expect(row!.status).toBe('pending');
    });
});
