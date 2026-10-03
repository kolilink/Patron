// E2E FIX BATCH A — money-critical (migration_v215). TEST DB only — do not commit.
//
// Exercises the seven server-side fixes against a real local Postgres
// instance (not mocked), one describe block per fix:
//
//   1. P0 — cancel_sale reverses investor_balance (symmetrical with submit_sale).
//   2. P0 — last-admin protection on the memberships DELETE path.
//   3. P0 — payout TOCTOU: confirm_payout row locks prevent double-deduct.
//   4. P1 — submit_sale discount guard (>= total, or negative, rejected).
//   5. P1 — submit_sale overpay guard (payment > total − discount rejected).
//   7. P1 — void_payment: vendeur own-payment check + cancelled-sale guard.
//   (6 is a client-only guard in app/(app)/(tabs)/vendre.tsx — no RPC surface.)
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

async function setInvestorScope(businessId: string, investorId: string, productId: string, profitShare: number) {
    const admin = adminClient();
    const { data: membership } = await admin
        .from('memberships').select('id').eq('business_id', businessId).eq('user_id', investorId).single();
    if (!membership) throw new Error('investor membership not found');
    const { error } = await admin.from('membership_product_scope').insert({
        membership_id: membership.id, product_id: productId, profit_share: profitShare,
    });
    if (error) throw error;
}

async function getInvestorBalance(businessId: string, investorId: string): Promise<number> {
    const admin = adminClient();
    const { data, error } = await admin
        .from('investor_balance').select('balance').eq('business_id', businessId).eq('investor_id', investorId).single();
    if (error) throw error;
    return data.balance as number;
}

describe('fix #1 — cancel_sale reverses investor_balance (migration_v215)', () => {
    it('accrue → cancel returns the investor balance to its pre-sale value', async () => {
        const { client, userId } = await createTestUser('admin');
        const businessId = await createTestBusiness(client, 'Boutique Test');
        const productId = await createTestProduct(businessId, userId, { cost_price: 500, sale_price: 1000 });

        const { client: investorC, userId: investorId } = await createTestUser('investisseur');
        await addMember(businessId, investorId, 'investisseur');
        await setInvestorScope(businessId, investorId, productId, 50);

        // Sold 2 @ 1000 (cost 500) → profit 500/unit × 2 = 1000 → investor 50% = 500.
        const orderId = await submitSale(client, businessId, userId, productId, 2, 1000);
        expect(await getInvestorBalance(businessId, investorId)).toBe(500);

        const { error } = await client.rpc('cancel_sale', {
            p_sale_id: orderId, p_business_id: businessId, p_reason: 'Erreur',
        });
        expect(error).toBeNull();

        expect(await getInvestorBalance(businessId, investorId)).toBe(0);
    });

    it('reverses each investor by their own profit_share (not a flat amount)', async () => {
        const { client, userId } = await createTestUser('admin');
        const businessId = await createTestBusiness(client, 'Boutique Test');
        const productId = await createTestProduct(businessId, userId, { cost_price: 500, sale_price: 1000 });

        const { client: invA, userId: invAId } = await createTestUser('investisseurA');
        const { client: invB, userId: invBId } = await createTestUser('investisseurB');
        await addMember(businessId, invAId, 'investisseur');
        await addMember(businessId, invBId, 'investisseur');
        await setInvestorScope(businessId, invAId, productId, 60);
        await setInvestorScope(businessId, invBId, productId, 40);

        const orderId = await submitSale(client, businessId, userId, productId, 2, 1000);
        expect(await getInvestorBalance(businessId, invAId)).toBe(600);
        expect(await getInvestorBalance(businessId, invBId)).toBe(400);

        await client.rpc('cancel_sale', { p_sale_id: orderId, p_business_id: businessId, p_reason: 'Erreur' });

        expect(await getInvestorBalance(businessId, invAId)).toBe(0);
        expect(await getInvestorBalance(businessId, invBId)).toBe(0);
    });
});

describe('fix #2 — last-admin protection on DELETE (migration_v215)', () => {
    it('denies a manager deleting the sole administrateur', async () => {
        const admin = await createTestUser('admin-del');
        const manager = await createTestUser('manager-del');
        const businessId = await createTestBusiness(admin.client, 'Boutique del');
        await addMember(businessId, manager.userId, 'manager');

        const svc = adminClient();
        const { data: adminMembership } = await svc
            .from('memberships').select('id').eq('business_id', businessId).eq('user_id', admin.userId).single();

        // RLS DELETE policies filter rows silently: a blocked delete returns
        // error=null but deletes zero rows. The correct assertion is that the
        // sole admin row still exists afterwards.
        await manager.client
            .from('memberships')
            .delete()
            .eq('id', adminMembership!.id);

        // The sole admin is still there.
        const { data: still } = await svc
            .from('memberships').select('role').eq('business_id', businessId).eq('user_id', admin.userId).single();
        expect(still?.role).toBe('administrateur');
    });

    it('still allows deleting an administrateur when another admin remains', async () => {
        const admin = await createTestUser('admin-del2');
        const admin2 = await createTestUser('admin-del2b');
        const manager = await createTestUser('manager-del2');
        const businessId = await createTestBusiness(admin.client, 'Boutique del2');
        const svc = adminClient();
        await svc.from('memberships').insert({ business_id: businessId, user_id: admin2.userId, role: 'administrateur' });
        await addMember(businessId, manager.userId, 'manager');
        const { data: admin2Membership } = await svc
            .from('memberships').select('id').eq('business_id', businessId).eq('user_id', admin2.userId).single();

        const { error } = await manager.client
            .from('memberships')
            .delete()
            .eq('id', admin2Membership!.id);

        expect(error).toBeNull();

        const { data: gone } = await svc
            .from('memberships').select('id').eq('id', admin2Membership!.id);
        expect(gone).toHaveLength(0);
    });
});

describe('fix #3 — payout TOCTOU row locks (migration_v215)', () => {
    it('concurrent confirms of the same payout deduct the balance exactly once', async () => {
        const { client: adminC, userId: adminId } = await createTestUser('payout-admin');
        const businessId = await createTestBusiness(adminC, 'Boutique Payout');
        const { client: investorC, userId: investorId } = await createTestUser('payout-investor');
        await addMember(businessId, investorId, 'investisseur');

        const svc = adminClient();
        await svc.from('investor_balance').insert({ business_id: businessId, investor_id: investorId, balance: 10000 });

        const { data: payoutId, error: reqErr } = await investorC.rpc('request_payout', { p_business_id: businessId, p_amount: 5000 });
        expect(reqErr).toBeNull();

        // Two confirms fired together — the row lock must serialize them so only
        // one deducts; the other re-reads status='paye' and raises.
        const [a, b] = await Promise.all([
            adminC.rpc('confirm_payout', { p_payout_id: payoutId, p_paid_amount: 5000 }),
            adminC.rpc('confirm_payout', { p_payout_id: payoutId, p_paid_amount: 5000 }),
        ]);

        const errors = [a.error, b.error].filter(Boolean);
        expect(errors).toHaveLength(1);
        expect(errors[0]!.message).toMatch(/déjà été traitée/);

        const { data: balance } = await svc
            .from('investor_balance').select('balance').eq('business_id', businessId).eq('investor_id', investorId).single();
        expect(balance!.balance).toBe(5000); // 10000 − 5000, not 0
    });
});

describe('fix #4 — submit_sale discount guard (migration_v215)', () => {
    it('rejects a discount >= the total', async () => {
        const { client, userId } = await createTestUser('disc-admin');
        const businessId = await createTestBusiness(client, 'Boutique Disc');
        const productId = await createTestProduct(businessId, userId, { stock_qty: 10 });

        const { error } = await client.rpc('submit_sale', {
            p_business_id: businessId,
            p_seller_id: userId,
            p_cart: [{ product_id: productId, product_name: 'x', qty: 1, unit_price: 1000 }],
            p_total_amount: 1000,
            p_discount_amount: 1000,
        });
        expect(error).toBeTruthy();
        expect(error!.message).toMatch(/inférieure au total/);
    });

    it('rejects a negative discount', async () => {
        const { client, userId } = await createTestUser('disc-admin2');
        const businessId = await createTestBusiness(client, 'Boutique Disc2');
        const productId = await createTestProduct(businessId, userId, { stock_qty: 10 });

        const { error } = await client.rpc('submit_sale', {
            p_business_id: businessId,
            p_seller_id: userId,
            p_cart: [{ product_id: productId, product_name: 'x', qty: 1, unit_price: 1000 }],
            p_total_amount: 1000,
            p_discount_amount: -1,
        });
        expect(error).toBeTruthy();
        expect(error!.message).toMatch(/négative/);
    });
});

describe('fix #5 — submit_sale overpay guard (migration_v215)', () => {
    it('rejects a payment exceeding the balance owed', async () => {
        const { client, userId } = await createTestUser('over-admin');
        const businessId = await createTestBusiness(client, 'Boutique Over');
        const productId = await createTestProduct(businessId, userId, { stock_qty: 10 });

        const { error } = await client.rpc('submit_sale', {
            p_business_id: businessId,
            p_seller_id: userId,
            p_cart: [{ product_id: productId, product_name: 'x', qty: 1, unit_price: 1000 }],
            p_total_amount: 1000,
            p_discount_amount: 0,
            p_pay_method: 'especes',
            p_pay_amount: 1500,
        });
        expect(error).toBeTruthy();
        expect(error!.message).toMatch(/dépasse le solde restant dû/);
    });
});

describe('fix #7 — void_payment own-payment + cancelled-sale guard (migration_v215)', () => {
    async function getPaymentId(orderId: string): Promise<string> {
        const svc = adminClient();
        const { data, error } = await svc.from('payments').select('id').eq('order_id', orderId).is('voided_at', null).single();
        if (error) throw error;
        return data.id as string;
    }

    it('denies a vendeur voiding another vendeur\'s payment, allows their own', async () => {
        const { client: adminC, userId: adminId } = await createTestUser('void-admin');
        const businessId = await createTestBusiness(adminC, 'Boutique Void');
        const productId = await createTestProduct(businessId, adminId, { stock_qty: 10 });

        const { client: sellerC, userId: sellerId } = await createTestUser('void-seller1');
        await addMember(businessId, sellerId, 'vendeur');
        const orderId = await submitSale(sellerC, businessId, sellerId, productId, 2, 1000);
        const paymentId = await getPaymentId(orderId);

        const { client: otherC, userId: otherId } = await createTestUser('void-seller2');
        await addMember(businessId, otherId, 'vendeur');

        const denied = await otherC.rpc('void_payment', { p_payment_id: paymentId, p_business_id: businessId, p_reason: 'Erreur' });
        expect(denied.error).toBeTruthy();
        expect(denied.error!.message).toMatch(/propres paiements/);

        const allowed = await sellerC.rpc('void_payment', { p_payment_id: paymentId, p_business_id: businessId, p_reason: 'Erreur' });
        expect(allowed.error).toBeNull();
    });

    it('denies voiding a payment on an already-cancelled sale', async () => {
        const { client, userId } = await createTestUser('void-admin2');
        const businessId = await createTestBusiness(client, 'Boutique Void2');
        const productId = await createTestProduct(businessId, userId, { stock_qty: 10 });

        const orderId = await submitSale(client, businessId, userId, productId, 2, 1000);
        const paymentId = await getPaymentId(orderId);

        // Simulate a cancelled sale whose payment row still exists (defense-in-depth:
        // cancel_sale normally deletes payments, but this guard must reject the
        // leftover rather than reopen the dead sale).
        const svc = adminClient();
        await svc.from('sale_orders').update({ status: 'annule' }).eq('id', orderId);

        const { error } = await client.rpc('void_payment', { p_payment_id: paymentId, p_business_id: businessId, p_reason: 'Erreur' });
        expect(error).toBeTruthy();
        expect(error!.message).toMatch(/vente annulée/);
    });
});
