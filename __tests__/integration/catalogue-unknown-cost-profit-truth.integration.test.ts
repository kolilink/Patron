// SWEEP FIX — Phase 1.4: catalogue "Rentabilité" profit "—" when a sold
// line has an unknown purchase cost (migration_v222). TEST DB only — do not
// commit.
//
// Proves the server-side half of the quick-sale/catalog profit truth chain:
//   1. get_product_stats returns a numeric profit when every sold line has a
//      real, positive snapshotted cost.
//   2. get_product_stats returns profit = null (JSON null) when a sold line's
//      cost is NULL — a v221 unknown-cost product.
//   3. get_product_stats returns profit = null for a quick sale, whose
//      "Vente rapide" line has cost_price_at_sale = NULL and whose system
//      placeholder product has cost_price = 0 (a fake, never a real recorded
//      purchase cost) — the old code read that 0 as a real cost and reported
//      100% margin fiction.
//
// get_product_stats is guarded by is_member(p_business_id) (auth.uid()), so
// it must be called through the signed-in member client, not the service-role
// admin client.
import { createTestUser, createTestBusiness, createTestProduct, adminClient } from './helpers';

async function submitSale(
    client: any, businessId: string, userId: string, productId: string,
    productName: string, qty: number, unitPrice: number,
): Promise<string> {
    const total = qty * unitPrice;
    const { data: orderId, error } = await client.rpc('submit_sale', {
        p_business_id: businessId,
        p_seller_id: userId,
        p_cart: [{ product_id: productId, product_name: productName, qty, unit_price: unitPrice }],
        p_total_amount: total,
        p_discount_amount: 0,
        p_pay_method: 'especes',
        p_pay_amount: total,
    });
    if (error) throw error;
    return orderId as string;
}

describe('Phase 1.4 — catalogue profit "—" when cost unknown (migration_v222)', () => {
    it('returns a numeric profit when every sold line has a real cost', async () => {
        const { client, userId } = await createTestUser('v222-known');
        const businessId = await createTestBusiness(client, 'Boutique Cout Connu');
        // cost_price 500, sold 2 × 2000 → revenue 4000, capital 1000, profit 3000.
        const productId = await createTestProduct(businessId, userId, {
            name: 'Produit cout connu', cost_price: 500, sale_price: 2000, stock_qty: 10,
        });

        await submitSale(client, businessId, userId, productId, 'Produit cout connu', 2, 2000);

        const { data, error } = await client.rpc('get_product_stats', {
            p_product_id: productId,
            p_business_id: businessId,
            p_since: null,
        });
        expect(error).toBeNull();
        expect(data).toBeTruthy();
        expect(data.profit).toBe(3000);
        expect(data.revenue).toBe(4000);
        expect(data.capital).toBe(1000);
    });

    it('returns null profit when a sold line has a NULL cost (v221 product)', async () => {
        const { client, userId } = await createTestUser('v222-nullcost');
        const businessId = await createTestBusiness(client, 'Boutique Cout Null');
        const admin = adminClient();

        const productId = await createTestProduct(businessId, userId, {
            name: 'Produit cout null', cost_price: 500, sale_price: 2000, stock_qty: 10,
        });
        // Overwrite to NULL to model a v221 unknown-cost product.
        const { error: nullifyErr } = await admin
            .from('products')
            .update({ cost_price: null })
            .eq('id', productId);
        expect(nullifyErr).toBeNull();

        await submitSale(client, businessId, userId, productId, 'Produit cout null', 2, 2000);

        const { data, error } = await client.rpc('get_product_stats', {
            p_product_id: productId,
            p_business_id: businessId,
            p_since: null,
        });
        expect(error).toBeNull();
        expect(data).toBeTruthy();
        // Revenue is still shown (always truthful), but profit must be NULL.
        expect(data.revenue).toBe(4000);
        expect(data.profit).toBeNull();
    });

    it('returns null profit for a quick sale (system product with cost 0)', async () => {
        const { client, userId } = await createTestUser('v222-quick');
        const businessId = await createTestBusiness(client, 'Boutique Rapide');
        const admin = adminClient();

        // submit_quick_sale creates the "Vente rapide" system product with
        // cost_price = 0 and inserts an so_line without cost_price_at_sale.
        const { data: orderId, error } = await client.rpc('submit_quick_sale', {
            p_business_id: businessId,
            p_seller_id: userId,
            p_unit_price: 5000, // 50 GNF in cents
            p_qty: 1,
        });
        expect(error).toBeNull();

        const { data: line } = await admin
            .from('so_lines')
            .select('product_id, cost_price_at_sale')
            .eq('order_id', orderId as string)
            .single();
        expect(line!.cost_price_at_sale).toBeNull();

        const { data: stats, error: statsErr } = await client.rpc('get_product_stats', {
            p_product_id: line!.product_id,
            p_business_id: businessId,
            p_since: null,
        });
        expect(statsErr).toBeNull();
        expect(stats).toBeTruthy();
        // Revenue 5000 is real; profit must be NULL — never 5000 (100% margin).
        expect(stats.revenue).toBe(5000);
        expect(stats.profit).toBeNull();
    });
});
