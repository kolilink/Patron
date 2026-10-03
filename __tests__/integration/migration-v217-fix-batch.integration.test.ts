// E2E FIX BATCH C — team & membership (migration_v217). TEST DB only — do not commit.
//
// Exercises the four server-side fixes against a real local Postgres instance
// (not mocked), one describe block per fix:
//
//   1. vendeur/investisseur can leave via leave_or_delete_business (the v215
//      memberships DELETE policy only admits administrateur/manager, so the
//      RPC is the only path for non-admins — this test proves the RPC deletes
//      their membership and leaves the business intact).
//   2. submit_sale enforces product scope keyed on scope_all_products (a
//      vendeur with scope_all_products=false and zero assigned products must
//      be blocked, not unrestricted — migration_v215 regression).
//   3. memberships_prevent_role_escalation refuses a second manager via a
//      direct UPDATE of role.
//   4. leave_or_delete_business cleans up the four non-cascading business_id
//      references before deleting the business, so a sole admin with real
//      activity leaves without an FK violation.
//   (5 is a client-only dream-flow/label fix in parametres/index.tsx — no RPC
//    surface, covered by the existing __tests__/leave-business.test.ts.)
import { randomUUID } from 'crypto';
import {
    createTestUser, createTestBusiness, addMember, createTestProduct, adminClient,
} from './helpers';

async function submitSale(
    client: any, businessId: string, userId: string, productId: string,
    qty: number, unitPrice: number, opts: { discount?: number; payAmount?: number; payMethod?: string } = {},
) {
    const total = qty * unitPrice;
    const { data: orderId, error } = await client.rpc('submit_sale', {
        p_business_id: businessId,
        p_seller_id: userId,
        p_cart: [{ product_id: productId, product_name: 'Produit test', qty, unit_price: unitPrice }],
        p_total_amount: total,
        p_discount_amount: opts.discount ?? 0,
        p_pay_method: opts.payMethod ?? 'especes',
        p_pay_amount: opts.payAmount === undefined ? total : opts.payAmount,
    });
    if (error) throw error;
    return orderId as string;
}

async function getMembershipId(businessId: string, userId: string): Promise<string> {
    const admin = adminClient();
    const { data, error } = await admin
        .from('memberships').select('id').eq('business_id', businessId).eq('user_id', userId).single();
    if (error || !data) throw error ?? new Error('membership not found');
    return data.id as string;
}

async function membershipExists(businessId: string, userId: string): Promise<boolean> {
    const admin = adminClient();
    const { data } = await admin
        .from('memberships').select('id').eq('business_id', businessId).eq('user_id', userId);
    return (data ?? []).length > 0;
}

async function businessExists(businessId: string): Promise<boolean> {
    const admin = adminClient();
    const { data } = await admin.from('businesses').select('id').eq('id', businessId);
    return (data ?? []).length > 0;
}

describe('fix #1 — vendeur/investisseur can leave via leave_or_delete_business (migration_v217)', () => {
    it('a vendeur leaves: only their membership is removed, the business stays', async () => {
        const admin = await createTestUser('leave-admin');
        const vendeur = await createTestUser('leave-vendeur');
        const businessId = await createTestBusiness(admin.client, 'Boutique Leave');

        await addMember(businessId, vendeur.userId, 'vendeur');

        const { error } = await vendeur.client.rpc('leave_or_delete_business', {
            p_business_id: businessId,
        });

        expect(error).toBeNull();
        expect(await membershipExists(businessId, vendeur.userId)).toBe(false);
        expect(await businessExists(businessId)).toBe(true);
    });

    it('an investisseur leaves: only their membership is removed, the business stays', async () => {
        const admin = await createTestUser('leave-inv-admin');
        const investisseur = await createTestUser('leave-investisseur');
        const businessId = await createTestBusiness(admin.client, 'Boutique Leave Inv');

        await addMember(businessId, investisseur.userId, 'investisseur');

        const { error } = await investisseur.client.rpc('leave_or_delete_business', {
            p_business_id: businessId,
        });

        expect(error).toBeNull();
        expect(await membershipExists(businessId, investisseur.userId)).toBe(false);
        expect(await businessExists(businessId)).toBe(true);
    });

    it('leaving does NOT delete the business\'s sales/payments/ledger rows', async () => {
        const admin = await createTestUser('leave-data-admin');
        const vendeur = await createTestUser('leave-data-vendeur');
        const businessId = await createTestBusiness(admin.client, 'Boutique Leave Data');
        const productId = await createTestProduct(businessId, admin.userId, { cost_price: 500, sale_price: 1000 });

        await addMember(businessId, vendeur.userId, 'vendeur');

        // A sale recorded by the vendeur before leaving.
        const orderId = await submitSale(vendeur.client, businessId, vendeur.userId, productId, 1, 1000);

        const { error } = await vendeur.client.rpc('leave_or_delete_business', {
            p_business_id: businessId,
        });
        expect(error).toBeNull();

        const svc = adminClient();
        const { data: orders } = await svc.from('sale_orders').select('id').eq('id', orderId);
        const { data: lines } = await svc.from('so_lines').select('id').eq('order_id', orderId);
        const { data: payments } = await svc.from('payments').select('id').eq('order_id', orderId);
        const { data: moves } = await svc.from('stock_moves').select('id').eq('ref_id', orderId);

        expect(orders).toHaveLength(1);
        expect(lines).toHaveLength(1);
        expect(payments).toHaveLength(1);
        expect(moves).toHaveLength(1);
        expect(await businessExists(businessId)).toBe(true);
    });
});

describe('fix #2 — submit_sale product scope keyed on scope_all_products (migration_v217)', () => {
    it('blocks a vendeur with scope_all_products=false and zero assigned products', async () => {
        const admin = await createTestUser('scope-admin');
        const vendeur = await createTestUser('scope-vendeur');
        const businessId = await createTestBusiness(admin.client, 'Boutique Scope');
        const productId = await createTestProduct(businessId, admin.userId, { sale_price: 1000 });

        await addMember(businessId, vendeur.userId, 'vendeur');
        const membershipId = await getMembershipId(businessId, vendeur.userId);

        // scope_all_products=false, and NO membership_product_scope rows exist.
        const svc = adminClient();
        await svc.from('memberships').update({ scope_all_products: false }).eq('id', membershipId);

        const { error } = await vendeur.client.rpc('submit_sale', {
            p_business_id: businessId,
            p_seller_id: vendeur.userId,
            p_cart: [{ product_id: productId, product_name: 'Produit test', qty: 1, unit_price: 1000 }],
            p_total_amount: 1000,
            p_discount_amount: 0,
            p_pay_method: 'especes',
            p_pay_amount: 1000,
        });

        expect(error).not.toBeNull();
        expect(error!.message).toMatch(/Vous n'avez pas encore de produits assignés/);
    });

    it('restricted vendeur can sell an assigned product but not an unassigned one', async () => {
        const admin = await createTestUser('scope2-admin');
        const vendeur = await createTestUser('scope2-vendeur');
        const businessId = await createTestBusiness(admin.client, 'Boutique Scope 2');
        const assigned = await createTestProduct(businessId, admin.userId, { name: 'Assigné', sale_price: 1000 });
        const unassigned = await createTestProduct(businessId, admin.userId, { name: 'Non assigné', sale_price: 2000 });

        await addMember(businessId, vendeur.userId, 'vendeur');
        const membershipId = await getMembershipId(businessId, vendeur.userId);

        const svc = adminClient();
        await svc.from('memberships').update({ scope_all_products: false }).eq('id', membershipId);
        await svc.from('membership_product_scope').insert({ membership_id: membershipId, product_id: assigned });

        // Unassigned → denied.
        const { error: deniedErr } = await vendeur.client.rpc('submit_sale', {
            p_business_id: businessId,
            p_seller_id: vendeur.userId,
            p_cart: [{ product_id: unassigned, product_name: 'Non assigné', qty: 1, unit_price: 2000 }],
            p_total_amount: 2000,
            p_discount_amount: 0,
            p_pay_method: 'especes',
            p_pay_amount: 2000,
        });
        expect(deniedErr).not.toBeNull();
        expect(deniedErr!.message).toMatch(/Produit non autorisé/);

        // Assigned → allowed.
        const orderId = await submitSale(vendeur.client, businessId, vendeur.userId, assigned, 1, 1000);
        expect(orderId).toBeTruthy();
    });

    it('a vendeur with scope_all_products=true can sell anything', async () => {
        const admin = await createTestUser('scope3-admin');
        const vendeur = await createTestUser('scope3-vendeur');
        const businessId = await createTestBusiness(admin.client, 'Boutique Scope 3');
        const productId = await createTestProduct(businessId, admin.userId, { sale_price: 1000 });

        await addMember(businessId, vendeur.userId, 'vendeur');
        // Default addMember leaves scope_all_products=TRUE and no scope rows.

        const orderId = await submitSale(vendeur.client, businessId, vendeur.userId, productId, 1, 1000);
        expect(orderId).toBeTruthy();
    });
});

describe('fix #3 — direct UPDATE cannot create a second manager (migration_v217)', () => {
    it('denies promoting a vendeur to manager when a manager already exists', async () => {
        const admin = await createTestUser('mgr-admin');
        const manager = await createTestUser('mgr-manager');
        const vendeur = await createTestUser('mgr-vendeur');
        const businessId = await createTestBusiness(admin.client, 'Boutique Mgr');

        await addMember(businessId, manager.userId, 'manager');
        await addMember(businessId, vendeur.userId, 'vendeur');
        const vendeurMembershipId = await getMembershipId(businessId, vendeur.userId);

        const { error } = await admin.client
            .from('memberships')
            .update({ role: 'manager' })
            .eq('id', vendeurMembershipId);

        expect(error).not.toBeNull();
        expect(error!.message).toMatch(/Cette boutique a déjà un gérant/);

        // The vendeur is still a vendeur.
        const svc = adminClient();
        const { data } = await svc
            .from('memberships').select('role').eq('id', vendeurMembershipId).single();
        expect(data?.role).toBe('vendeur');
    });

    it('still allows promoting a vendeur to manager when no manager exists', async () => {
        const admin = await createTestUser('mgr2-admin');
        const vendeur = await createTestUser('mgr2-vendeur');
        const businessId = await createTestBusiness(admin.client, 'Boutique Mgr 2');

        await addMember(businessId, vendeur.userId, 'vendeur');
        const vendeurMembershipId = await getMembershipId(businessId, vendeur.userId);

        const { error } = await admin.client
            .from('memberships')
            .update({ role: 'manager' })
            .eq('id', vendeurMembershipId);

        expect(error).toBeNull();

        const svc = adminClient();
        const { data } = await svc
            .from('memberships').select('role').eq('id', vendeurMembershipId).single();
        expect(data?.role).toBe('manager');
    });
});

describe('fix #4 — sole-admin leave cleans up non-cascading references (migration_v217)', () => {
    it('a sole admin with real activity leaves without an FK violation and the business is deleted', async () => {
        const admin = await createTestUser('leave-sole-admin');
        const other = await createTestUser('leave-other-admin');
        const businessId = await createTestBusiness(admin.client, 'Boutique Sole');
        const otherBusinessId = await createTestBusiness(other.client, 'Boutique Autre');

        const svc = adminClient();

        // 1. notification_log.business_id is NOT NULL with no cascade.
        await svc.from('notification_log').insert({
            business_id: businessId, event_type: 'low_stock', payload: {},
        });

        // 2. reconciliation_findings.business_id is nullable with no cascade.
        const { data: run, error: runErr } = await svc
            .from('reconciliation_runs').insert({ status: 'findings' }).select('id').single();
        if (runErr) throw runErr;
        await svc.from('reconciliation_findings').insert({
            run_id: run!.id, check_id: 1, domain: 'Stock', check_name: 'test', severity: 'warning',
            business_id: businessId, detail: 'x',
        });

        // 3. businesses.referred_by_business_id self-reference, no cascade.
        await svc.from('businesses').update({ referred_by_business_id: businessId }).eq('id', otherBusinessId);

        // 4. partner_invite_codes.used_by_business_id nullable, no cascade.
        await svc.from('partner_invite_codes').insert({
            business_id: otherBusinessId,
            code: `C-${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`,
            used_by_business_id: businessId,
        });

        const { error } = await admin.client.rpc('leave_or_delete_business', {
            p_business_id: businessId,
        });

        expect(error).toBeNull();
        expect(await businessExists(businessId)).toBe(false);

        // The other business is untouched and its dangling references were cleared.
        const { data: otherBiz } = await svc
            .from('businesses').select('referred_by_business_id').eq('id', otherBusinessId).single();
        expect(otherBiz?.referred_by_business_id).toBeNull();
        const { data: codes } = await svc
            .from('partner_invite_codes').select('used_by_business_id').eq('business_id', otherBusinessId);
        expect(codes).toHaveLength(1);
        expect(codes![0].used_by_business_id).toBeNull();
    });

    it('still refuses a sole admin to leave when other members remain', async () => {
        const admin = await createTestUser('leave-blocked-admin');
        const vendeur = await createTestUser('leave-blocked-vendeur');
        const businessId = await createTestBusiness(admin.client, 'Boutique Blocked');

        await addMember(businessId, vendeur.userId, 'vendeur');

        const { error } = await admin.client.rpc('leave_or_delete_business', {
            p_business_id: businessId,
        });

        expect(error).not.toBeNull();
        expect(error!.message).toMatch(/a d'autres membres actifs/);
        expect(await businessExists(businessId)).toBe(true);
    });
});
