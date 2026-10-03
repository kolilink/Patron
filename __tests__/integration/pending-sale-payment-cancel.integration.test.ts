// P0-1: payments/cancels against pending (queued) sales were lost at drain.
//
// Offline-first write path: submit_carnet_debt / submit_quick_sale /
// submit_sale are queued locally and projected into the pending overlay
// with the projected local id = the sale's idempotency_key (see
// lib/pendingOverlay.ts projectNewSale). When the user pays or cancels one
// of those projected sales before the queue drains, the client sends the
// projected id (the idempotency_key) as p_sale_id.
//
// migration_v211 makes record_payment and cancel_sale resolve the sale in
// two steps — first WHERE id = p_sale_id, else WHERE idempotency_key =
// p_sale_id, both scoped to p_business_id — so a payment/cancel targeting
// a projected id lands on the REAL server row instead of raising
// "Vente introuvable" (or, worse, resolving against stale state).
//
// Verified against a real local Postgres instance, not mocked.
import { randomUUID } from 'crypto';
import { createTestUser, createTestBusiness, createTestProduct, adminClient, getProductStock } from './helpers';

describe('pending-sale payment/cancel resolution (migration_v211)', () => {
    it('payment with p_sale_id = idempotency_key lands on the real server row', async () => {
        const { client, userId } = await createTestUser('admin');
        const businessId = await createTestBusiness(client, 'Boutique Test');

        // Simulate the offline path: a queued credit sale is projected into the
        // overlay with projected id = its idempotency_key.
        const key = randomUUID();
        const { data: realOrderId, error: submitErr } = await client.rpc('submit_carnet_debt', {
            p_business_id: businessId,
            p_seller_id: userId,
            p_customer_name: 'Aissatou',
            p_amount: 1000000,
            p_idempotency_key: key,
        });
        expect(submitErr).toBeNull();
        expect(realOrderId as string).not.toBe(key); // real id differs from the projected key

        // The client sends the projected id (the key) as p_sale_id.
        const { error: payErr, data } = await client.rpc('record_payment', {
            p_sale_id: key,
            p_business_id: businessId,
            p_amount: 1000000,
            p_method: 'especes',
            p_date: '2026-09-28',
            p_idempotency_key: randomUUID(),
        });
        expect(payErr).toBeNull();
        expect((data as { fully_paid: boolean; payment_id: string }).fully_paid).toBe(true);

        // The payment must have landed on the REAL row, not a phantom.
        const admin = adminClient();
        const { data: order } = await admin
            .from('sale_orders')
            .select('status')
            .eq('id', realOrderId as string)
            .single();
        expect(order?.status).toBe('paye');

        const { data: payments } = await admin.from('payments').select('amount').eq('order_id', realOrderId as string);
        expect((payments ?? []).reduce((s, p) => s + (p.amount as number), 0)).toBe(1000000);
    });

    it('replaying the same payment key against a projected id does not double-pay', async () => {
        const { client, userId } = await createTestUser('admin');
        const businessId = await createTestBusiness(client, 'Boutique Test');

        const saleKey = randomUUID();
        await client.rpc('submit_carnet_debt', {
            p_business_id: businessId,
            p_seller_id: userId,
            p_customer_name: 'Ousmane',
            p_amount: 400000,
            p_idempotency_key: saleKey,
        });

        const paymentKey = randomUUID();
        const payload = {
            p_sale_id: saleKey,
            p_business_id: businessId,
            p_amount: 400000,
            p_method: 'especes',
            p_date: '2026-09-28',
            p_idempotency_key: paymentKey,
        };

        const first = await client.rpc('record_payment', payload);
        expect(first.error).toBeNull();
        const replay = await client.rpc('record_payment', payload);
        expect(replay.error).toBeNull();
        expect((replay.data as { fully_paid: boolean; payment_id: string }).payment_id)
            .toBe((first.data as { fully_paid: boolean; payment_id: string }).payment_id);

        const admin = adminClient();
        const { data: order } = await admin
            .from('sale_orders')
            .select('id')
            .eq('business_id', businessId)
            .single();
        const { data: payments } = await admin.from('payments').select('amount').eq('order_id', order!.id as string);
        expect((payments ?? []).reduce((s, p) => s + (p.amount as number), 0)).toBe(400000);
    });

    it('cancel with p_sale_id = idempotency_key annuls the sale and restores stock', async () => {
        const { client, userId } = await createTestUser('admin');
        const businessId = await createTestBusiness(client, 'Boutique Test');
        const productId = await createTestProduct(businessId, userId, { stock_qty: 10, sale_price: 1000 });

        const saleKey = randomUUID();
        const { data: realOrderId, error: submitErr } = await client.rpc('submit_sale', {
            p_business_id: businessId,
            p_seller_id: userId,
            p_customer_name: 'Mamadou',
            p_sale_date: '2026-09-28',
            p_total_amount: 2000,
            p_discount_amount: 0,
            p_is_credit: false,
            p_cart: [{ product_id: productId, qty: 2, unit_price: 1000, is_bulk: false }],
            p_pay_method: 'especes',
            p_pay_amount: 2000,
            p_idempotency_key: saleKey,
        });
        expect(submitErr).toBeNull();
        expect(await getProductStock(productId)).toBe(8); // 10 - 2 sold

        // The client sends the projected id (the key) as p_sale_id.
        const { error: cancelErr, data: cancelled } = await client.rpc('cancel_sale', {
            p_sale_id: saleKey,
            p_business_id: businessId,
            p_reason: 'erreur',
        });
        expect(cancelErr).toBeNull();
        expect(cancelled).toBe(true);

        const admin = adminClient();
        const { data: order } = await admin
            .from('sale_orders')
            .select('status')
            .eq('id', realOrderId as string)
            .single();
        expect(order?.status).toBe('annule');
        // Stock restored onto the real row's product.
        expect(await getProductStock(productId)).toBe(10);
    });

    it('unknown uuid raises "Vente introuvable"', async () => {
        const { client } = await createTestUser('admin');
        const businessId = await createTestBusiness(client, 'Boutique Test');

        const { error } = await client.rpc('record_payment', {
            p_sale_id: randomUUID(),
            p_business_id: businessId,
            p_amount: 100,
            p_method: 'especes',
            p_date: '2026-09-28',
            p_idempotency_key: randomUUID(),
        });
        expect(error).toBeTruthy();
        expect(error!.message).toMatch(/Vente introuvable/);
    });

    it('cross-business key is rejected — no resolution across tenants', async () => {
        const { client: clientA, userId: userIdA } = await createTestUser('bizA');
        const businessA = await createTestBusiness(clientA, 'Boutique A');
        const { client: clientB } = await createTestUser('bizB');
        const businessB = await createTestBusiness(clientB, 'Boutique B');

        const saleKey = randomUUID();
        await clientA.rpc('submit_carnet_debt', {
            p_business_id: businessA,
            p_seller_id: userIdA,
            p_customer_name: 'Sekou',
            p_amount: 1000000,
            p_idempotency_key: saleKey,
        });

        // businessB tries to pay against businessA's key — the resolution is
        // scoped to p_business_id, so it must not find the row.
        const { error } = await clientB.rpc('record_payment', {
            p_sale_id: saleKey,
            p_business_id: businessB,
            p_amount: 1000000,
            p_method: 'especes',
            p_date: '2026-09-28',
            p_idempotency_key: randomUUID(),
        });
        expect(error).toBeTruthy();
        expect(error!.message).toMatch(/Vente introuvable/);

        // And businessA's real row is untouched by the cross-business attempt.
        const admin = adminClient();
        const { data: payments } = await admin
            .from('payments')
            .select('id')
            .eq('business_id', businessA);
        expect(payments ?? []).toHaveLength(0);
    });
});
