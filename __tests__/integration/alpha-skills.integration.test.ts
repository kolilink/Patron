// Alpha glass-wall skills (db/migration_v210.sql) — real Postgres, real RLS,
// real SECURITY DEFINER RPCs. Proves the two properties that a mock cannot:
//   1. Each skill returns values independently computable from the underlying
//      tables (revenue, credit balance, stock, top products/clients) — no
//      cross-business bleed, no invented aggregation.
//   2. Item 5 isolation: business A returns ZERO business B rows, and a
//      vendeur only ever sees their own sales while an admin sees the whole
//      business; an investisseur is denied (autorise=false), and a non-member
//      is rejected outright.
//
// submit_sale() (migration_v93) is used to create real orders/lines/payments.
// No edge function, no Groq — only the deterministic RPCs themselves.
import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
    createTestUser, createTestBusiness, addMember, createTestProduct, adminClient,
} from './helpers';

async function makeSale(
    client: SupabaseClient,
    businessId: string,
    sellerId: string,
    productId: string,
    productName: string,
    qty: number,
    unitPrice: number,
    opts: { customerName?: string; isCredit?: boolean; dueDate?: string | null } = {},
): Promise<string> {
    const { data, error } = await client.rpc('submit_sale', {
        p_business_id: businessId,
        p_seller_id: sellerId,
        p_customer_name: opts.customerName ?? null,
        p_cart: [{ product_id: productId, product_name: productName, qty, unit_price: unitPrice }],
        p_total_amount: qty * unitPrice,
        p_pay_method: opts.isCredit ? null : 'especes',
        p_pay_amount: opts.isCredit ? null : qty * unitPrice,
        p_is_credit: opts.isCredit ?? false,
        p_due_date: opts.dueDate ?? null,
    });
    if (error) throw error;
    return data;
}

async function insertPayment(admin: ReturnType<typeof adminClient>, orderId: string, businessId: string, amount: number): Promise<void> {
    const { error } = await admin.from('payments').insert({
        id: randomUUID(),
        order_id: orderId,
        business_id: businessId,
        method: 'especes',
        amount,
        date: new Date().toISOString().slice(0, 10),
    });
    if (error) throw error;
}

const todayIso = new Date().toISOString().slice(0, 10);

describe('alpha_skill_ventes_periode — independently-computed revenue + item-5 isolation', () => {
    it('returns the business revenue (paye + credit) summed independently, with the envelope shape', async () => {
        const { client, userId } = await createTestUser('alpha-vp-admin');
        const businessId = await createTestBusiness(client, 'Boutique VP');
        const productId = await createTestProduct(businessId, userId, { stock_qty: 100, sale_price: 1000, cost_price: 500 });

        await makeSale(client, businessId, userId, productId, 'Riz', 3, 1000); // 3000
        await makeSale(client, businessId, userId, productId, 'Riz', 2, 1000); // 2000
        await makeSale(client, businessId, userId, productId, 'Riz', 1, 1000, { isCredit: true }); // 1000 credit — still counts

        const { data, error } = await client.rpc('alpha_skill_ventes_periode', {
            p_business_id: businessId, p_debut: todayIso, p_fin: todayIso,
        });

        expect(error).toBeNull();
        expect(data.intention).toBe('ventes_periode');
        expect(data.autorise).toBe(true);
        expect(Number(data.valeur)).toBe(6000); // 3000 + 2000 + 1000 credit
        expect(Number(data.nombre_ventes)).toBe(3);
        expect(data.provenance).toContain('ventes');
        expect(data.chemin_details.ecran).toBe('ventes');
        expect(typeof data.version_donnees).toBe('number');
    });

    it('business A returns ZERO business B rows — no cross-business bleed', async () => {
        const { client: aC, userId: aUid } = await createTestUser('alpha-vp-a');
        const businessA = await createTestBusiness(aC, 'Boutique A');
        const productA = await createTestProduct(businessA, aUid, { stock_qty: 100, sale_price: 1000 });
        await makeSale(aC, businessA, aUid, productA, 'Produit A', 3, 1000); // 3000

        const { client: bC, userId: bUid } = await createTestUser('alpha-vp-b');
        const businessB = await createTestBusiness(bC, 'Boutique B');
        const productB = await createTestProduct(businessB, bUid, { stock_qty: 100, sale_price: 9999 });
        await makeSale(bC, businessB, bUid, productB, 'Produit B', 9, 9999); // 89991

        const { data: aData, error: aErr } = await aC.rpc('alpha_skill_ventes_periode', {
            p_business_id: businessA, p_debut: todayIso, p_fin: todayIso,
        });
        expect(aErr).toBeNull();
        expect(Number(aData.valeur)).toBe(3000); // exactly A, never 92991 or 89991

        const { data: bData, error: bErr } = await bC.rpc('alpha_skill_ventes_periode', {
            p_business_id: businessB, p_debut: todayIso, p_fin: todayIso,
        });
        expect(bErr).toBeNull();
        expect(Number(bData.valeur)).toBe(89991);
    });

    it('a vendeur only sees their own sales; an admin sees the whole business', async () => {
        const { client: adminC, userId: adminId } = await createTestUser('alpha-vp-owner');
        const businessId = await createTestBusiness(adminC, 'Boutique Roles');
        const productId = await createTestProduct(businessId, adminId, { stock_qty: 100, sale_price: 1000 });

        const { client: vendC, userId: vendId } = await createTestUser('alpha-vp-vendeur');
        await addMember(businessId, vendId, 'vendeur');

        await makeSale(adminC, businessId, adminId, productId, 'Riz', 5, 1000);   // admin: 5000
        await makeSale(vendC, businessId, vendId, productId, 'Riz', 2, 1000);      // vendeur: 2000

        const adminView = await adminC.rpc('alpha_skill_ventes_periode', {
            p_business_id: businessId, p_debut: todayIso, p_fin: todayIso,
        });
        expect(adminView.error).toBeNull();
        expect(Number(adminView.data.valeur)).toBe(7000); // whole business

        const vendeurView = await vendC.rpc('alpha_skill_ventes_periode', {
            p_business_id: businessId, p_debut: todayIso, p_fin: todayIso,
        });
        expect(vendeurView.error).toBeNull();
        expect(Number(vendeurView.data.valeur)).toBe(2000); // own only — never 7000
    });

    it('an investisseur is denied (autorise=false) — never an exception, never data', async () => {
        const { client: adminC, userId: adminId } = await createTestUser('alpha-vp-inv-owner');
        const businessId = await createTestBusiness(adminC, 'Boutique Inv');
        const productId = await createTestProduct(businessId, adminId, { stock_qty: 10, sale_price: 1000 });
        await makeSale(adminC, businessId, adminId, productId, 'Riz', 1, 1000);

        const { client: invC, userId: invId } = await createTestUser('alpha-vp-inv');
        await addMember(businessId, invId, 'investisseur');

        const { data, error } = await invC.rpc('alpha_skill_ventes_periode', {
            p_business_id: businessId, p_debut: todayIso, p_fin: todayIso,
        });
        expect(error).toBeNull();
        expect(data.autorise).toBe(false);
        expect(data.valeur).toBe(0);
        expect(data.raison).toBeTruthy();
    });

    it('a non-member is rejected outright', async () => {
        const { client: adminC, userId: adminId } = await createTestUser('alpha-vp-nm-owner');
        const businessId = await createTestBusiness(adminC, 'Boutique NM');

        const { client: outsiderC } = await createTestUser('alpha-vp-nm-outsider');
        const { error } = await outsiderC.rpc('alpha_skill_ventes_periode', {
            p_business_id: businessId, p_debut: todayIso, p_fin: todayIso,
        });
        expect(error).toBeTruthy();
        expect(error!.message).toMatch(/Accès refusé/);
    });
});

describe('alpha_skill_creances — independently-computed balances (read-only)', () => {
    it('returns each credit balance = total - discount - paid, and marks overdue', async () => {
        const { client, userId } = await createTestUser('alpha-cr-admin');
        const businessId = await createTestBusiness(client, 'Boutique CR');
        const productId = await createTestProduct(businessId, userId, { stock_qty: 100, sale_price: 1000 });

        // Credit sale 5000, no payment → balance 5000, overdue (due_date in past).
        const overdueId = await makeSale(client, businessId, userId, productId, 'Riz', 5, 1000, {
            isCredit: true, customerName: 'Mamadou', dueDate: '2020-01-01',
        });

        // Credit sale 4000 with a 1500 payment → balance 2500, not overdue.
        const openId = await makeSale(client, businessId, userId, productId, 'Huile', 4, 1000, {
            isCredit: true, customerName: 'Fatou',
        });
        const admin = adminClient();
        await insertPayment(admin, openId, businessId, 1500);

        // A paid sale must NOT appear as a receivable.
        await makeSale(client, businessId, userId, productId, 'Sel', 1, 1000);

        const { data, error } = await client.rpc('alpha_skill_creances', { p_business_id: businessId });
        expect(error).toBeNull();
        expect(data.intention).toBe('creances');
        expect(data.autorise).toBe(true);

        const rows = data.valeur as Array<Record<string, unknown>>;
        const mamadou = rows.find(r => r.client === 'Mamadou');
        const fatou = rows.find(r => r.client === 'Fatou');

        expect(Number(mamadou!.montant_du)).toBe(5000);
        expect(mamadou!.en_retard).toBe(true);
        expect(Number(fatou!.montant_du)).toBe(2500);
        expect(fatou!.en_retard).toBe(false);
        expect(rows).toHaveLength(2); // the paid sale is absent
        void overdueId;
    });

    it('an investisseur is denied; a vendeur sees only their own receivables', async () => {
        const { client: adminC, userId: adminId } = await createTestUser('alpha-cr-owner');
        const businessId = await createTestBusiness(adminC, 'Boutique CR Roles');
        const productId = await createTestProduct(businessId, adminId, { stock_qty: 100, sale_price: 1000 });

        const { client: vendC, userId: vendId } = await createTestUser('alpha-cr-vendeur');
        await addMember(businessId, vendId, 'vendeur');

        const { client: invC, userId: invId } = await createTestUser('alpha-cr-inv');
        await addMember(businessId, invId, 'investisseur');

        await makeSale(adminC, businessId, adminId, productId, 'Riz', 3, 1000, { isCredit: true, customerName: 'AdminClient' });
        await makeSale(vendC, businessId, vendId, productId, 'Riz', 2, 1000, { isCredit: true, customerName: 'VendeurClient' });

        const vendeurView = await vendC.rpc('alpha_skill_creances', { p_business_id: businessId });
        expect(vendeurView.error).toBeNull();
        const vendRows = vendeurView.data.valeur as Array<Record<string, unknown>>;
        expect(vendRows).toHaveLength(1);
        expect(vendRows[0].client).toBe('VendeurClient');

        const invView = await invC.rpc('alpha_skill_creances', { p_business_id: businessId });
        expect(invView.error).toBeNull();
        expect(invView.data.autorise).toBe(false);
    });
});

describe('alpha_skill_stock_bas — low-stock products across all roles', () => {
    it('returns only products at or below their reorder level, cheapest first', async () => {
        const { client, userId } = await createTestUser('alpha-sb-admin');
        const businessId = await createTestBusiness(client, 'Boutique SB');

        await createTestProduct(businessId, userId, { name: 'Sous seuil', stock_qty: 2, sale_price: 1000, cost_price: 500 });
        await createTestProduct(businessId, userId, { name: 'Au seuil', stock_qty: 5, sale_price: 1000, cost_price: 500 });
        await createTestProduct(businessId, userId, { name: 'Bien rempli', stock_qty: 50, sale_price: 1000, cost_price: 500 });

        const admin = adminClient();
        // Set reorder levels: Sous seuil → 10 (2 <= 10), Au seuil → 5 (5 <= 5),
        // Bien rempli → 10 (50 > 10, excluded).
        await admin.from('products').update({ reorder_level: 10 }).eq('name', 'Sous seuil').eq('business_id', businessId);
        await admin.from('products').update({ reorder_level: 5 }).eq('name', 'Au seuil').eq('business_id', businessId);
        await admin.from('products').update({ reorder_level: 10 }).eq('name', 'Bien rempli').eq('business_id', businessId);

        const { data, error } = await client.rpc('alpha_skill_stock_bas', { p_business_id: businessId });
        expect(error).toBeNull();
        expect(data.autorise).toBe(true);

        const rows = data.valeur as Array<Record<string, unknown>>;
        const names = rows.map(r => r.produit);
        expect(names).toContain('Sous seuil');
        expect(names).toContain('Au seuil');
        expect(names).not.toContain('Bien rempli');
        expect(rows[0].produit).toBe('Sous seuil'); // lowest stock first
    });
});

describe('alpha_skill_top_produits / top_clients — independent rankings', () => {
    it('top_produits ranks by revenue, top_clients by total purchases', async () => {
        const { client, userId } = await createTestUser('alpha-top-admin');
        const businessId = await createTestBusiness(client, 'Boutique Top');
        const pA = await createTestProduct(businessId, userId, { name: 'Riz', stock_qty: 100, sale_price: 1000 });
        const pB = await createTestProduct(businessId, userId, { name: 'Huile', stock_qty: 100, sale_price: 2000 });

        // Riz: 4 × 1000 = 4000 across two clients; Huile: 1 × 2000 = 2000.
        await makeSale(client, businessId, userId, pA, 'Riz', 3, 1000, { customerName: 'Mamadou' });
        await makeSale(client, businessId, userId, pA, 'Riz', 1, 1000, { customerName: 'Fatou' });
        await makeSale(client, businessId, userId, pB, 'Huile', 1, 2000, { customerName: 'Mamadou' });

        const produits = await client.rpc('alpha_skill_top_produits', {
            p_business_id: businessId, p_debut: todayIso, p_fin: todayIso,
        });
        expect(produits.error).toBeNull();
        const prods = produits.data.valeur as Array<Record<string, unknown>>;
        expect(prods[0].produit).toBe('Riz');
        expect(Number(prods[0].quantite_vendue)).toBe(4);
        expect(Number(prods[0].revenu)).toBe(4000);

        const clients = await client.rpc('alpha_skill_top_clients', {
            p_business_id: businessId, p_debut: todayIso, p_fin: todayIso,
        });
        expect(clients.error).toBeNull();
        const cli = clients.data.valeur as Array<Record<string, unknown>>;
        expect(cli[0].client).toBe('Mamadou'); // 3000 + 2000 = 5000
        expect(Number(cli[0].total_achats)).toBe(5000);
        expect(Number(cli[0].nombre_ventes)).toBe(2);
    });

    it('a vendeur sees only their own products/clients', async () => {
        const { client: adminC, userId: adminId } = await createTestUser('alpha-top-owner');
        const businessId = await createTestBusiness(adminC, 'Boutique Top Roles');
        const productId = await createTestProduct(businessId, adminId, { name: 'Riz', stock_qty: 100, sale_price: 1000 });

        const { client: vendC, userId: vendId } = await createTestUser('alpha-top-vendeur');
        await addMember(businessId, vendId, 'vendeur');

        await makeSale(adminC, businessId, adminId, productId, 'Riz', 9, 1000, { customerName: 'AdminClient' });
        await makeSale(vendC, businessId, vendId, productId, 'Riz', 1, 1000, { customerName: 'VendeurClient' });

        const vendProds = await vendC.rpc('alpha_skill_top_produits', {
            p_business_id: businessId, p_debut: todayIso, p_fin: todayIso,
        });
        expect(vendProds.error).toBeNull();
        const prods = vendProds.data.valeur as Array<Record<string, unknown>>;
        expect(Number(prods[0].quantite_vendue)).toBe(1); // only their own 1 unit

        const vendClients = await vendC.rpc('alpha_skill_top_clients', {
            p_business_id: businessId, p_debut: todayIso, p_fin: todayIso,
        });
        expect(vendClients.error).toBeNull();
        const cli = vendClients.data.valeur as Array<Record<string, unknown>>;
        expect(cli[0].client).toBe('VendeurClient');
    });
});
