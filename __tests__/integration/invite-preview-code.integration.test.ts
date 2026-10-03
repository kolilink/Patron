// Invite preview by manual CODE (migration_v214) — the non-destructive
// twin of preview_consumer_invite, keyed on the 10-char manual code used
// by the new /invite/<CODE> landing page. Proven here, not assumed:
//   1. a live invite resolves to the inviter's display-name snapshot;
//   2. an expired invite and an unknown code both return valid=false;
//   3. previewing NEVER consumes the invite (status stays 'active').
//
// Run against a real local Postgres:
//   npx jest --config jest.integration.config.js invite-preview-code --runInBand

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { adminClient, createTestUser, createTestBusiness } from './helpers';

const LOCAL_URL = process.env.TEST_SUPABASE_URL || 'http://127.0.0.1:54321';
const LOCAL_ANON_KEY = process.env.TEST_SUPABASE_ANON_KEY
    || 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';

const admin = adminClient();

function anonClient(): SupabaseClient {
    return createClient(LOCAL_URL, LOCAL_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function setProfileName(userId: string, name: string): Promise<void> {
    const { error } = await admin.from('profiles').update({ name }).eq('id', userId);
    if (error) throw error;
}

async function inviteStatus(inviteId: string): Promise<string> {
    const { data, error } = await admin.from('consumer_invites')
        .select('status')
        .eq('id', inviteId)
        .single();
    if (error) throw error;
    return data?.status as string;
}

describe('preview_consumer_invite_code (real Postgres, migration_v214)', () => {
    it('resolves a live code to the inviter display-name snapshot, without consuming it', async () => {
        const inviter = await createTestUser('preview-inviter');
        await setProfileName(inviter.userId, 'Awa Diallo');
        await createTestBusiness(inviter.client, 'Boutique preview');

        const { data: created, error: createErr } = await inviter.client.rpc('create_consumer_invite');
        expect(createErr).toBeNull();
        const { id, code } = created as { id: string; code: string };

        const { data: preview, error: previewErr } = await anonClient().rpc('preview_consumer_invite_code', {
            p_code: code,
        });
        expect(previewErr).toBeNull();
        expect(preview).toMatchObject({ valid: true, inviter_name: 'Awa Diallo' });

        // The key invariant: previewing must never flip status to 'used'.
        await expect(inviteStatus(id)).resolves.toBe('active');
    });

    it('is case-insensitive on the code', async () => {
        const inviter = await createTestUser('preview-case');
        await setProfileName(inviter.userId, 'Boubacar');
        await createTestBusiness(inviter.client, 'Boutique case');

        const { data: created } = await inviter.client.rpc('create_consumer_invite');
        const { code } = created as { code: string };

        const { data: preview, error } = await anonClient().rpc('preview_consumer_invite_code', {
            p_code: code.toLowerCase(),
        });
        expect(error).toBeNull();
        expect(preview).toMatchObject({ valid: true, inviter_name: 'Boubacar' });
    });

    it('returns valid=false for an unknown code', async () => {
        const { data, error } = await anonClient().rpc('preview_consumer_invite_code', {
            p_code: 'ZZZZZZZZZZ',
        });
        expect(error).toBeNull();
        expect(data).toEqual({ valid: false, inviter_name: null });
    });

    it('returns valid=false for an expired invite', async () => {
        const inviter = await createTestUser('preview-expired');
        await setProfileName(inviter.userId, 'Coumba');
        await createTestBusiness(inviter.client, 'Boutique expirée');

        const { data: created } = await inviter.client.rpc('create_consumer_invite');
        const { id, code } = created as { id: string; code: string };

        await admin.from('consumer_invites')
            .update({ expires_at: new Date(Date.now() - 1000).toISOString() })
            .eq('id', id);

        const { data: preview, error } = await anonClient().rpc('preview_consumer_invite_code', {
            p_code: code,
        });
        expect(error).toBeNull();
        expect(preview).toEqual({ valid: false, inviter_name: null });
    });

    it('still returns valid=false after the invite is consumed (status used)', async () => {
        const inviter = await createTestUser('preview-consumed');
        await setProfileName(inviter.userId, 'Djenaba');
        await createTestBusiness(inviter.client, 'Boutique consommée');

        const { data: created } = await inviter.client.rpc('create_consumer_invite');
        const { id, code } = created as { id: string; code: string };

        await admin.from('consumer_invites').update({ status: 'used' }).eq('id', id);

        const { data: preview, error } = await anonClient().rpc('preview_consumer_invite_code', {
            p_code: code,
        });
        expect(error).toBeNull();
        expect(preview).toEqual({ valid: false, inviter_name: null });
    });
});
