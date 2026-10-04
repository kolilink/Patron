// SWEEP FIX — Phase 2: finalize_account_deletion must clean up the four
// non-cascading business_id references before DELETE FROM businesses, exactly
// like leave_or_delete_business (migration_v217). TEST DB only — do not commit.
//
// Proves the cron hard-delete path (migration_v223 superset of v178) no longer
// FK-violates on a business with real activity (notification_log.business_id is
// NOT NULL with no cascade), and that the whole profile is still fully removed
// when the delete succeeds.
import {
    createTestUser, createTestBusiness, adminClient,
} from './helpers';

describe('Phase 2 — finalize_account_deletion cleans up non-cascading refs (migration_v223)', () => {
    it('deletes a business that has notification_log activity and removes the profile/auth user', async () => {
        const { client, userId } = await createTestUser('v223-del');
        const businessId = await createTestBusiness(client, 'Boutique Suppression');
        const admin = adminClient();

        // A business with real activity: notification_log.business_id is
        // NOT NULL and does NOT cascade, so the old v178 body would
        // FK-violate here and strand the whole profile.
        const { error: logErr } = await admin.from('notification_log').insert({
            business_id: businessId,
            event_type: 'test_event',
            payload: { reason: 'phase2' },
            recipient_count: 0,
        });
        expect(logErr).toBeNull();

        // Schedule deletion in the past so the finalize function's due-check passes.
        const { error: scheduleErr } = await admin
            .from('profiles')
            .update({ pending_deletion_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() })
            .eq('id', userId);
        expect(scheduleErr).toBeNull();

        // The cron calls finalize_account_deletion with the service role.
        const { error: finalizeErr } = await admin.rpc('finalize_account_deletion', {
            p_user_id: userId,
        });
        expect(finalizeErr).toBeNull();

        // Business gone, and its non-cascading notification_log rows gone with it.
        const { data: biz } = await admin.from('businesses').select('id').eq('id', businessId).maybeSingle();
        expect(biz).toBeNull();

        const { data: log } = await admin.from('notification_log').select('id').eq('business_id', businessId).maybeSingle();
        expect(log).toBeNull();

        // The profile and the auth user are fully removed.
        const { data: profile } = await admin.from('profiles').select('id').eq('id', userId).maybeSingle();
        expect(profile).toBeNull();

        const { data: authUser, error: authErr } = await admin.auth.admin.getUserById(userId);
        expect(authErr).toBeTruthy();
        expect(authUser?.user ?? null).toBeNull();
    });

    it('skips (does not delete) when the deletion is not yet due', async () => {
        const { client, userId } = await createTestUser('v223-future');
        const businessId = await createTestBusiness(client, 'Boutique Future');
        const admin = adminClient();

        // pending_deletion_at in the future → finalize must RETURN without deleting.
        const { error: scheduleErr } = await admin
            .from('profiles')
            .update({ pending_deletion_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() })
            .eq('id', userId);
        expect(scheduleErr).toBeNull();

        const { error: finalizeErr } = await admin.rpc('finalize_account_deletion', {
            p_user_id: userId,
        });
        expect(finalizeErr).toBeNull();

        const { data: biz } = await admin.from('businesses').select('id').eq('id', businessId).maybeSingle();
        expect(biz).not.toBeNull();

        const { data: profile } = await admin.from('profiles').select('id').eq('id', userId).maybeSingle();
        expect(profile).not.toBeNull();
    });
});
