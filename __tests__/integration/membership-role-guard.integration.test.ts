// P0-3: manager self-promotion guard (migration_v212).
//
// The memberships UPDATE path is now split:
//   * RLS stays permissive for admin/manager (so managers can still edit
//     non-role columns like display_name / scope_all_products), but
//   * a BEFORE UPDATE OF role trigger enforces:
//       - only an administrateur may change `role`;
//       - the last administrateur cannot be demoted.

import { adminClient, addMember, createTestBusiness, createTestUser } from './helpers';

async function membershipRole(businessId: string, userId: string): Promise<string | null> {
    const admin = adminClient();
    const { data, error } = await admin
        .from('memberships')
        .select('role')
        .eq('business_id', businessId)
        .eq('user_id', userId)
        .single();
    if (error) throw error;
    return (data?.role as string | null) ?? null;
}

describe('memberships role guard (real RLS + trigger, migration_v212)', () => {
    it('denies a manager promoting themselves to administrateur', async () => {
        const admin = await createTestUser('role-admin');
        const manager = await createTestUser('role-manager');
        const businessId = await createTestBusiness(admin.client, 'Boutique rôle');
        await addMember(businessId, manager.userId, 'manager');

        const { error } = await manager.client
            .from('memberships')
            .update({ role: 'administrateur' })
            .eq('business_id', businessId)
            .eq('user_id', manager.userId);

        expect(error).toBeTruthy();
        expect(error!.message).toContain('Seul un administrateur peut modifier les rôles');
        await expect(membershipRole(businessId, manager.userId)).resolves.toBe('manager');
    });

    it('denies a manager changing another member\'s role', async () => {
        const admin = await createTestUser('role-admin2');
        const manager = await createTestUser('role-manager2');
        const vendeur = await createTestUser('role-vendeur');
        const businessId = await createTestBusiness(admin.client, 'Boutique rôle 2');
        await addMember(businessId, manager.userId, 'manager');
        await addMember(businessId, vendeur.userId, 'vendeur');

        const { error } = await manager.client
            .from('memberships')
            .update({ role: 'manager' })
            .eq('business_id', businessId)
            .eq('user_id', vendeur.userId);

        expect(error).toBeTruthy();
        expect(error!.message).toContain('Seul un administrateur peut modifier les rôles');
        await expect(membershipRole(businessId, vendeur.userId)).resolves.toBe('vendeur');
    });

    it('allows an administrateur to change a member\'s role', async () => {
        const admin = await createTestUser('role-admin3');
        const vendeur = await createTestUser('role-vendeur3');
        const businessId = await createTestBusiness(admin.client, 'Boutique rôle 3');
        await addMember(businessId, vendeur.userId, 'vendeur');

        const { error } = await admin.client
            .from('memberships')
            .update({ role: 'manager' })
            .eq('business_id', businessId)
            .eq('user_id', vendeur.userId);

        expect(error).toBeNull();
        await expect(membershipRole(businessId, vendeur.userId)).resolves.toBe('manager');
    });

    it('denies demoting the last administrateur', async () => {
        const admin = await createTestUser('role-solo-admin');
        const businessId = await createTestBusiness(admin.client, 'Boutique solo');

        const { error } = await admin.client
            .from('memberships')
            .update({ role: 'manager' })
            .eq('business_id', businessId)
            .eq('user_id', admin.userId);

        expect(error).toBeTruthy();
        expect(error!.message).toContain('Impossible de rétrograder le dernier administrateur');
        await expect(membershipRole(businessId, admin.userId)).resolves.toBe('administrateur');
    });

    it('still allows a manager to update non-role columns (display_name)', async () => {
        const owner = await createTestUser('role-admin4');
        const manager = await createTestUser('role-manager4');
        const businessId = await createTestBusiness(owner.client, 'Boutique rôle 4');
        await addMember(businessId, manager.userId, 'manager');

        const { error } = await manager.client
            .from('memberships')
            .update({ display_name: 'Gérant Test' })
            .eq('business_id', businessId)
            .eq('user_id', manager.userId);

        expect(error).toBeNull();

        const svc = adminClient();
        const { data } = await svc
            .from('memberships')
            .select('display_name')
            .eq('business_id', businessId)
            .eq('user_id', manager.userId)
            .single();
        expect(data?.display_name).toBe('Gérant Test');
    });
});
