// E2E FIX BATCH D — catalog & carnet (migration_v218). TEST DB only — do not commit.
//
// Exercises the server-side fixes against a real local Postgres instance (not
// mocked), one describe block per fix:
//
//   1. upsert_product_variants archives removed variants instead of deleting
//      them, and upserts by name (preserving ids), so re-saving a variant
//      product after its first sale/PO no longer fails on the
//      so_lines.variant_id / po_lines.variant_id FK.
//   2. confirm_reception accepts an optional p_received_date and stamps
//      ordered_at/received_at with it (backdated delivery dates).
//   4. stock_moves.variant_id is populated by receive_purchase_order,
//      cancel_sale and upsert_product_variants (variant audit trail).
//   (3 and 5 are client-side / edge-function only — no RPC surface here.)
import {
    createTestUser, createTestBusiness, createTestProduct, createTestVariant, adminClient,
} from './helpers';

async function submitVariantSale(
    client: any, businessId: string, userId: string, productId: string,
    variantId: string, variantName: string, qty: number, unitPrice: number,
): Promise<string> {
    const total = qty * unitPrice;
    const { data: orderId, error } = await client.rpc('submit_sale', {
        p_business_id: businessId,
        p_seller_id: userId,
        p_cart: [{ product_id: productId, product_name: 'Produit test', qty, unit_price: unitPrice, variant_id: variantId, variant_name: variantName }],
        p_total_amount: total,
        p_discount_amount: 0,
        p_pay_method: 'especes',
        p_pay_amount: total,
    });
    if (error) throw error;
    return orderId as string;
}

async function getVariantByName(productId: string, name: string): Promise<Record<string, any> | null> {
    const admin = adminClient();
    const { data, error } = await admin
        .from('product_variants')
        .select('id, name, stock_qty, sale_price, archived')
        .eq('product_id', productId)
        .eq('name', name)
        .maybeSingle();
    if (error) throw error;
    return data;
}

describe('fix #1 — upsert_product_variants archives instead of deleting (migration_v218)', () => {
    it('re-saving a variant product after a variant sale succeeds and preserves the variant id', async () => {
        const { client, userId } = await createTestUser('d1-resave');
        const businessId = await createTestBusiness(client, 'Boutique Resave');
        const productId = await createTestProduct(businessId, userId);
        const variantId = await createTestVariant(productId, businessId, { name: 'Taille M', stock_qty: 50, sale_price: 1000 });

        // First sale creates an so_lines row referencing the variant (the FK that
        // used to break the next save).
        await submitVariantSale(client, businessId, userId, productId, variantId, 'Taille M', 2, 1000);

        const { error } = await client.rpc('upsert_product_variants', {
            p_business_id: businessId,
            p_product_id: productId,
            p_variants: [{ name: 'Taille M', sale_price: 1200, cost_price: 600, stock_qty: 48, reorder_level: 5 }],
        });

        expect(error).toBeNull();
        const variant = await getVariantByName(productId, 'Taille M');
        expect(variant).toBeTruthy();
        expect(variant!.id).toBe(variantId); // id preserved, not deleted + re-created
        expect(variant!.stock_qty).toBe(48);
        expect(variant!.sale_price).toBe(1200);
        expect(variant!.archived).toBe(false);
    });

    it('removing a variant archives it instead of deleting it (no FK violation)', async () => {
        const { client, userId } = await createTestUser('d1-archive');
        const businessId = await createTestBusiness(client, 'Boutique Archive');
        const productId = await createTestProduct(businessId, userId);
        const variantId = await createTestVariant(productId, businessId, { name: 'Taille M', stock_qty: 20 });

        await submitVariantSale(client, businessId, userId, productId, variantId, 'Taille M', 1, 1000);

        const { error } = await client.rpc('upsert_product_variants', {
            p_business_id: businessId,
            p_product_id: productId,
            p_variants: [{ name: 'Taille L', sale_price: 1500, cost_price: 700, stock_qty: 30, reorder_level: 0 }],
        });

        expect(error).toBeNull();
        const removed = await getVariantByName(productId, 'Taille M');
        expect(removed).toBeTruthy(); // still exists (archived), not hard-deleted
        expect(removed!.archived).toBe(true);

        const added = await getVariantByName(productId, 'Taille L');
        expect(added).toBeTruthy();
        expect(added!.archived).toBe(false);
    });
});

describe('fix #2 — confirm_reception accepts p_received_date (migration_v218)', () => {
    it('stamps ordered_at/received_at with the backdated date', async () => {
        const { client, userId } = await createTestUser('d2-date');
        const businessId = await createTestBusiness(client, 'Boutique Date');
        const productId = await createTestProduct(businessId, userId, { stock_qty: 0, cost_price: 500 });

        const { data: poId, error } = await client.rpc('confirm_reception', {
            p_business_id: businessId,
            p_lines: [{ product_id: productId, qty: 5, unit_cost_cents: 60000 }],
            p_received_date: '2026-01-15',
        });

        expect(error).toBeNull();
        expect(poId).toBeTruthy();

        const admin = adminClient();
        const { data: po, error: poErr } = await admin
            .from('purchase_orders').select('ordered_at, received_at').eq('id', poId).single();
        expect(poErr).toBeNull();
        expect(new Date(po!.ordered_at).toISOString().slice(0, 10)).toBe('2026-01-15');
        expect(new Date(po!.received_at).toISOString().slice(0, 10)).toBe('2026-01-15');
    });

    it('still works when p_received_date is omitted (no regression)', async () => {
        const { client, userId } = await createTestUser('d2-regress');
        const businessId = await createTestBusiness(client, 'Boutique Regress');
        const productId = await createTestProduct(businessId, userId, { stock_qty: 0, cost_price: 500 });

        const { data: poId, error } = await client.rpc('confirm_reception', {
            p_business_id: businessId,
            p_lines: [{ product_id: productId, qty: 3, unit_cost_cents: 60000 }],
        });

        expect(error).toBeNull();
        expect(poId).toBeTruthy();

        const admin = adminClient();
        const { data: po } = await admin
            .from('purchase_orders').select('ordered_at, received_at').eq('id', poId).single();
        expect(po).toBeTruthy();
        expect(po!.ordered_at).toBeTruthy();
        expect(po!.received_at).toBeTruthy();
    });
});

describe('fix #4 — stock_moves.variant_id populated (migration_v218)', () => {
    it('receive_purchase_order stamps variant_id on its stock move', async () => {
        const { client, userId } = await createTestUser('d4-receive');
        const businessId = await createTestBusiness(client, 'Boutique Receive');
        const productId = await createTestProduct(businessId, userId);
        const variantId = await createTestVariant(productId, businessId, { name: 'Taille M', stock_qty: 0, cost_price: 500 });

        const { error } = await client.rpc('confirm_reception', {
            p_business_id: businessId,
            p_lines: [{ product_id: productId, variant_id: variantId, qty: 5, unit_cost_cents: 60000 }],
        });
        expect(error).toBeNull();

        const admin = adminClient();
        const { data: moves, error: mvErr } = await admin
            .from('stock_moves').select('variant_id').eq('business_id', businessId).eq('ref_type', 'purchase_order');
        expect(mvErr).toBeNull();
        expect(moves).toHaveLength(1);
        expect(moves![0].variant_id).toBe(variantId);
    });

    it('cancel_sale stamps variant_id on its restock move', async () => {
        const { client, userId } = await createTestUser('d4-cancel');
        const businessId = await createTestBusiness(client, 'Boutique Cancel');
        const productId = await createTestProduct(businessId, userId);
        const variantId = await createTestVariant(productId, businessId, { name: 'Taille M', stock_qty: 50 });

        const orderId = await submitVariantSale(client, businessId, userId, productId, variantId, 'Taille M', 2, 1000);

        const { error } = await client.rpc('cancel_sale', {
            p_sale_id: orderId,
            p_business_id: businessId,
            p_reason: 'Erreur',
        });
        expect(error).toBeNull();

        const admin = adminClient();
        const { data: moves, error: mvErr } = await admin
            .from('stock_moves').select('variant_id').eq('business_id', businessId).eq('ref_type', 'annulation');
        expect(mvErr).toBeNull();
        expect(moves).toHaveLength(1);
        expect(moves![0].variant_id).toBe(variantId);
    });

    it('upsert_product_variants stamps variant_id on stock deltas', async () => {
        const { client, userId } = await createTestUser('d4-upsert');
        const businessId = await createTestBusiness(client, 'Boutique Upsert');
        const productId = await createTestProduct(businessId, userId);
        const variantId = await createTestVariant(productId, businessId, { name: 'Taille M', stock_qty: 50 });

        const { error } = await client.rpc('upsert_product_variants', {
            p_business_id: businessId,
            p_product_id: productId,
            p_variants: [{ name: 'Taille M', sale_price: 1000, cost_price: 500, stock_qty: 60, reorder_level: 0 }],
        });
        expect(error).toBeNull();

        const admin = adminClient();
        const { data: moves, error: mvErr } = await admin
            .from('stock_moves').select('variant_id, type').eq('business_id', businessId).eq('ref_type', 'manuel');
        expect(mvErr).toBeNull();
        expect(moves).toHaveLength(1);
        expect(moves![0].variant_id).toBe(variantId);
        expect(moves![0].type).toBe('entree');
    });
});
