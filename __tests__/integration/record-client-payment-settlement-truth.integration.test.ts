// Settlement truth for the "C'est réglé !" overlay fix.
//
// The UI overlay must only celebrate a settled debt when the remaining balance
// is exactly 0 after the payment. The source of truth for "exactly settled" is
// record_client_payment's `fully_settled` flag — verified here against a real
// local Postgres instance for a MULTI-entry ledger (several credit sales under
// one customer name, the FIFO fan-out path), not mocked.
//
// - a payment that brings the multi-entry ledger to exactly 0   -> fully_settled true  (overlay celebrates)
// - a payment that brings it to 1 (one unit left)               -> fully_settled false (overlay shows "Reste")
import { randomUUID } from 'crypto';
import { createTestUser, createTestBusiness, adminClient } from './helpers';

async function creditSale(
    client: ReturnType<typeof adminClient>,
    businessId: string,
    sellerId: string,
    customerName: string,
    amountCents: number,
) {
    const { data: orderId, error } = await client.rpc('submit_carnet_debt', {
        p_business_id: businessId,
        p_seller_id: sellerId,
        p_customer_name: customerName,
        p_amount: amountCents,
    });
    if (error) throw error;
    return orderId as string;
}

async function pay(
    client: ReturnType<typeof adminClient>,
    businessId: string,
    customerName: string,
    amountCents: number,
) {
    const { data, error } = await client.rpc('record_client_payment', {
        p_business_id: businessId,
        p_customer_name: customerName,
        p_amount: amountCents,
        p_method: 'especes',
        p_date: '2026-10-03',
        p_idempotency_key: randomUUID(),
    });
    if (error) throw error;
    return data as { fully_settled: boolean; payment_ids: string[] };
}

describe('record_client_payment — settlement truth for the overlay (real RPC)', () => {
    it('a payment that brings a multi-entry ledger to exactly 0 reports fully_settled true', async () => {
        const { client, userId } = await createTestUser('admin');
        const businessId = await createTestBusiness(client, 'Boutique Test');
        // Two credit entries under one customer: 100 000 GNF + 50 000 GNF.
        await creditSale(client, businessId, userId, 'Aissatou', 10000000);
        await creditSale(client, businessId, userId, 'Aissatou', 5000000);

        // Single payment of the full 150 000 — FIFO fans out across both sales
        // and nets the ledger to exactly 0.
        const result = await pay(client, businessId, 'Aissatou', 15000000);
        expect(result.fully_settled).toBe(true);
    });

    it('a payment that leaves exactly 1 unit reports fully_settled false (no settlement celebration)', async () => {
        const { client, userId } = await createTestUser('admin');
        const businessId = await createTestBusiness(client, 'Boutique Test');
        await creditSale(client, businessId, userId, 'Ousmane', 10000000);
        await creditSale(client, businessId, userId, 'Ousmane', 5000000);

        // 149 999 of 150 000 — leaves exactly 1 GNF, which must NOT read as settled.
        const partial = await pay(client, businessId, 'Ousmane', 14999900);
        expect(partial.fully_settled).toBe(false);

        // The final 1 GNF settles it — truth flips to settled only now.
        const final = await pay(client, businessId, 'Ousmane', 100);
        expect(final.fully_settled).toBe(true);
    });
});
