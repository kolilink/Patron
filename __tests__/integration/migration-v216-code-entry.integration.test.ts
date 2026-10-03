// E2E FIX BATCH B — invite CODE-ENTRY loop (migration_v206 + migration_v216).
// TEST DB only — do not commit.
//
// The smart-link path (p_token) has been integration-tested since v216, but
// the manual 10-char CODE path (p_code) has never been exercised end-to-end.
// This file proves every link of the typed-entry journey:
//
//   C1 — full loop: inviter mints an invite, the 10-char code is returned,
//        the invitee redeems via resolve_consumer_invite(p_token='', p_code=…),
//        and BOTH sides see each other in list_my_consumer_friends.
//   C2 — wrong case is accepted (the server hashes upper(btrim(p_code))).
//   C3 — spaces + wrong case are accepted AFTER client-side normalization
//        (the server does NOT strip internal spaces — that is the one gap
//        this suite documents, fixed in stores/inviter.normalizeInviteCode).
//   C4 — a wrong code raises one generic error and leaves zero partial state.
//   C5 — an expired code raises one generic error.
//   C6 — an already-redeemed code is rejected for a second user.
//
// Run against a real local Postgres:
//   npx jest --config jest.integration.config.js migration-v216-code-entry --runInBand

import type { SupabaseClient } from '@supabase/supabase-js';
import { adminClient, createTestUser, createTestBusiness } from './helpers';

const admin = adminClient();

interface CreatedInvite { id: string; token: string; code: string; expires_at: string }
interface ResolvedInvite { inviter_id: string; inviter_name: string; newly_used: boolean }
interface FriendRow { id: string; friend_id: string; friend_name: string; invited_at: string }

// Mirrors stores/inviter.normalizeInviteCode — kept local so this suite does
// not drag the React Native store graph into the node test environment.
function normalizeInviteCode(raw: string): string {
    return raw.replace(/\s+/g, '').toUpperCase();
}

async function createInvite(inviter: { client: SupabaseClient }): Promise<CreatedInvite> {
    const { data, error } = await inviter.client.rpc('create_consumer_invite');
    expect(error).toBeNull();
    const invite = data as CreatedInvite;
    expect(invite.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/); // 32-char alphabet, no I/L/O/U
    return invite;
}

describe('C1 — full code→redeem loop (migration_v206 + v216)', () => {
    it('inviter mints a code; invitee redeems via p_code; both see each other in Amis', async () => {
        const inviter = await createTestUser('c1-inviter');
        await createTestBusiness(inviter.client, 'Boutique invitante c1');

        const joiner = await createTestUser('c1-joiner');
        await createTestBusiness(joiner.client, 'Boutique rejointe c1');

        const invite = await createInvite(inviter);

        // Typed entry: the code goes in p_code, the token slot stays empty.
        const { data: resolved, error: resolveErr } = await joiner.client.rpc('resolve_consumer_invite', {
            p_token: '',
            p_code: invite.code,
        });
        expect(resolveErr).toBeNull();
        expect((resolved as ResolvedInvite).inviter_id).toBe(inviter.userId);
        expect((resolved as ResolvedInvite).newly_used).toBe(true);

        // leg (a) — the joiner sees the inviter.
        const { data: joinerFriends } = await joiner.client.rpc('list_my_consumer_friends');
        expect((joinerFriends as FriendRow[]).map(f => f.friend_id)).toContain(inviter.userId);

        // leg (b) — the inviter sees the joiner (bidirectional, B1).
        const { data: inviterFriends, error: friendsErr } = await inviter.client.rpc('list_my_consumer_friends');
        expect(friendsErr).toBeNull();
        expect((inviterFriends as FriendRow[]).map(f => f.friend_id)).toContain(joiner.userId);
    });
});

describe('C2/C3 — code normalization (case + spaces)', () => {
    it('a lowercase code is accepted (server uppercases)', async () => {
        const inviter = await createTestUser('c2-inviter');
        await createTestBusiness(inviter.client, 'Boutique invitante c2');
        const joiner = await createTestUser('c2-joiner');
        await createTestBusiness(joiner.client, 'Boutique rejointe c2');

        const invite = await createInvite(inviter);

        const { data: resolved, error } = await joiner.client.rpc('resolve_consumer_invite', {
            p_token: '',
            p_code: invite.code.toLowerCase(),
        });
        expect(error).toBeNull();
        expect((resolved as ResolvedInvite).inviter_id).toBe(inviter.userId);
    });

    it('a code with internal spaces + wrong case is accepted after client normalization', async () => {
        const inviter = await createTestUser('c3-inviter');
        await createTestBusiness(inviter.client, 'Boutique invitante c3');
        const joiner = await createTestUser('c3-joiner');
        await createTestBusiness(joiner.client, 'Boutique rejointe c3');

        const invite = await createInvite(inviter);

        // The human-typed form: "AB3K M9ZX" — spaces + lowercase mixed in.
        const typed = `${invite.code.slice(0, 4)} ${invite.code.slice(4)}`.toLowerCase();
        expect(typed).not.toBe(invite.code); // sanity — the raw form differs

        // Gap documented: the server hashes upper(btrim(p_code)) — it does NOT
        // strip internal spaces, so the raw spaced form would fail. The client
        // must normalize first (stores/inviter.normalizeInviteCode).
        const { error: rawErr } = await joiner.client.rpc('resolve_consumer_invite', {
            p_token: '',
            p_code: typed,
        });
        expect(rawErr).toBeTruthy();

        // Normalized → accepted.
        const { data: resolved, error } = await joiner.client.rpc('resolve_consumer_invite', {
            p_token: '',
            p_code: normalizeInviteCode(typed),
        });
        expect(error).toBeNull();
        expect((resolved as ResolvedInvite).inviter_id).toBe(inviter.userId);
        expect(normalizeInviteCode(typed)).toBe(invite.code);
    });
});

describe('C4 — wrong code leaves zero partial state', () => {
    it('raises one generic error and the inviter never appears in the joiner Amis', async () => {
        const inviter = await createTestUser('c4-inviter');
        await createTestBusiness(inviter.client, 'Boutique invitante c4');
        const joiner = await createTestUser('c4-joiner');
        await createTestBusiness(joiner.client, 'Boutique rejointe c4');

        // No invite is even created — the wrong code must simply not resolve.
        const { data, error } = await joiner.client.rpc('resolve_consumer_invite', {
            p_token: '',
            p_code: 'ZZZZZZZZZZ', // 10 chars, guaranteed not to exist
        });
        expect(error).toBeTruthy();
        expect(error!.message).toMatch(/invitation invalide/i);
        expect(data).toBeNull();

        const { data: friends } = await joiner.client.rpc('list_my_consumer_friends');
        expect((friends as FriendRow[]).map(f => f.friend_id)).not.toContain(inviter.userId);
    });
});

describe('C5 — expired code raises one generic error', () => {
    it('a backdated (expired) code is refused with no friendship', async () => {
        const inviter = await createTestUser('c5-inviter');
        await createTestBusiness(inviter.client, 'Boutique invitante c5');
        const joiner = await createTestUser('c5-joiner');
        await createTestBusiness(joiner.client, 'Boutique rejointe c5');

        const invite = await createInvite(inviter);

        // Backdate past the 24h window (service role bypasses the no-write RLS).
        const { error: backdateErr } = await admin
            .from('consumer_invites')
            .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
            .eq('id', invite.id);
        expect(backdateErr).toBeNull();

        const { data, error } = await joiner.client.rpc('resolve_consumer_invite', {
            p_token: '',
            p_code: invite.code,
        });
        expect(error).toBeTruthy();
        expect(error!.message).toMatch(/invitation invalide/i);
        expect(data).toBeNull();

        const { data: friends } = await joiner.client.rpc('list_my_consumer_friends');
        expect((friends as FriendRow[]).map(f => f.friend_id)).not.toContain(inviter.userId);
    });
});

describe('C6 — already-redeemed code is rejected for a second user', () => {
    it('a second invitee cannot reuse the same code', async () => {
        const inviter = await createTestUser('c6-inviter');
        await createTestBusiness(inviter.client, 'Boutique invitante c6');

        const joiner1 = await createTestUser('c6-joiner1');
        await createTestBusiness(joiner1.client, 'Boutique rejointe c6-1');

        const joiner2 = await createTestUser('c6-joiner2');
        await createTestBusiness(joiner2.client, 'Boutique rejointe c6-2');

        const invite = await createInvite(inviter);

        const first = await joiner1.client.rpc('resolve_consumer_invite', {
            p_token: '',
            p_code: invite.code,
        });
        expect(first.error).toBeNull();
        expect((first.data as ResolvedInvite).newly_used).toBe(true);

        const second = await joiner2.client.rpc('resolve_consumer_invite', {
            p_token: '',
            p_code: invite.code,
        });
        expect(second.error).toBeTruthy();
        expect(second.error!.message).toMatch(/invitation invalide/i);
        expect(second.data).toBeNull();

        // joiner2 gained nothing.
        const { data: friends2 } = await joiner2.client.rpc('list_my_consumer_friends');
        expect((friends2 as FriendRow[]).map(f => f.friend_id)).not.toContain(inviter.userId);
    });
});
