// SWEEP FIX — Phase 1.3: "Prix inconnu" for a received item (migration_v221).
// TEST DB only — do not commit.
//
// Proves the server-side half of the blank-cost truth chain:
//   1. confirm_reception with a blank/absent unit_cost_cents saves a NULL
//      po_lines.unit_cost and a NULL products.cost_price — never a fake 0.
//   2. A sale of that unknown-cost product snapshots cost_price_at_sale = NULL,
//      and get_period_report (v220) reports sales_without_cost ≥ 1 while
//      excluding the unknown-cost revenue from net_profit.
import {
    createTestUser, createTestBusiness, createTestProduct, adminClient,
} from './helpers';

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

describe('Phase 1.3 — blank purchase cost is "unknown", not 0 (migration_v221)', () => {
    it('confirm_reception with a blank unit_cost_cents saves NULL cost_price and NULL unit_cost', async () => {
        const { client, userId } = await createTestUser('v221-blank');
        const businessId = await createTestBusiness(client, 'Boutique Inconnu');

        // A brand-new product received without a purchase cost — the exact case
        // the old UI refused to even allow (it forced cost > 0).
        const { data: poId, error } = await client.rpc('confirm_reception', {
            p_business_id: businessId,
            p_lines: [{ product_id: null, name: 'Produit sans prix', qty: 5 }],
        });

        expect(error).toBeNull();
        expect(poId).toBeTruthy();

        const admin = adminClient();

        // po_lines.unit_cost must be NULL (unknown), not 0.
        const { data: poLine, error: poLineErr } = await admin
            .from('po_lines')
            .select('unit_cost')
            .eq('po_id', poId)
            .single();
        expect(poLineErr).toBeNull();
        expect(poLine!.unit_cost).toBeNull();

        // The created product's cost_price must be NULL (unknown), not 0.
        const { data: product, error: productErr } = await admin
            .from('products')
            .select('cost_price, stock_qty')
            .eq('business_id', businessId)
            .eq('name', 'Produit sans prix')
            .single();
        expect(productErr).toBeNull();
        expect(product!.cost_price).toBeNull();
        expect(product!.stock_qty).toBe(5); // stock still increments
    });

    it('a sale of an unknown-cost product snapshots NULL cost and is excluded from net_profit', async () => {
        const { client, userId } = await createTestUser('v221-sale');
        const businessId = await createTestBusiness(client, 'Boutique Vente Inconnu');
        const admin = adminClient();

        // Insert a product whose cost is genuinely unknown (NULL).
        const productId = await createTestProduct(businessId, userId, {
            name: 'Produit cout inconnu', stock_qty: 10, sale_price: 2000,
        });
        // createTestProduct always writes a cost; overwrite it to NULL to model
        // an unknown-cost product as migration_v221 now allows.
        const { error: nullifyErr } = await admin
            .from('products')
            .update({ cost_price: null })
            .eq('id', productId);
        expect(nullifyErr).toBeNull();

        const orderId = await submitSale(client, businessId, userId, productId, 'Produit cout inconnu', 2, 2000);

        // The sale snapshots the (NULL) cost.
        const { data: line, error: lineErr } = await admin
            .from('so_lines')
            .select('cost_price_at_sale')
            .eq('order_id', orderId)
            .single();
        expect(lineErr).toBeNull();
        expect(line!.cost_price_at_sale).toBeNull();

        // get_period_report must (a) count this as a sale-without-cost and
        // (b) exclude its revenue from net_profit — a single 2×2000 sale with
        // unknown cost contributes 0 profit.
        const today = new Date().toISOString().slice(0, 10);
        const { data: report, error: reportErr } = await admin.rpc('get_period_report', {
            p_business_id: businessId,
            p_period_start: today,
            p_period_end: today,
            p_role: 'administrateur',
            p_user_id: userId,
        });
        expect(reportErr).toBeNull();
        expect(report.sales_without_cost).toBeGreaterThanOrEqual(1);
        expect(report.net_profit).toBe(0);
    });
});
