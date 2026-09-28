// §7 of the offline-first rewrite: record_client_payment (migration_v195)
// gains real idempotency via a dedicated claim table
// (record_client_payment_idempotency_keys), not a column on `payments`
// itself — see that migration's own header comment for why (the FIFO
// allocation can fan out into a variable number of payments rows per
// call, unlike submit_sale/submit_carnet_debt's single-row pattern).
//
// This is the money-safety-critical case for the whole offline outbox
// rework: once recordClientPayment (stores/ventes.ts) goes local-write-
// first, a drain retry after a partial network failure (the call actually
// succeeded server-side, but the client never got the response) must
// replay the exact same RPC call with the exact same idempotency key —
// and it must NOT double-allocate the payment. Verified against a real
// local Postgres instance, not mocked.
import { randomUUID } from 'crypto';
import { createTestUser, createTestBusiness, adminClient } from './helpers';

async function creditSale(client: ReturnType<typeof adminClient>, businessId: string, sellerId: string, customerName: string, amountCents: number) {
  const { data: orderId, error } = await client.rpc('submit_carnet_debt', {
    p_business_id: businessId,
    p_seller_id: sellerId,
    p_customer_name: customerName,
    p_amount: amountCents,
  });
  if (error) throw error;
  return orderId as string;
}

async function saleState(orderId: string) {
  const admin = adminClient();
  const { data, error } = await admin.from('sale_orders').select('status, total_amount, discount_amount').eq('id', orderId).single();
  if (error) throw error;
  const { data: payments } = await admin.from('payments').select('amount').eq('order_id', orderId);
  return { status: data!.status as string, totalAmount: data!.total_amount as number, amountPaid: (payments ?? []).reduce((s, p) => s + (p.amount as number), 0) };
}

describe('record_client_payment — idempotency (real RPC, migration_v195)', () => {
  it('replaying the exact same call with the same idempotency key does not double-allocate the payment', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const orderId = await creditSale(client, businessId, userId, 'Aissatou', 1000000); // 10000 GNF

    const idempotencyKey = randomUUID();
    const payload = {
      p_business_id: businessId,
      p_customer_name: 'Aissatou',
      p_amount: 1000000, // full payment, 10000 GNF in cents
      p_method: 'especes',
      p_date: '2026-09-28',
      p_idempotency_key: idempotencyKey,
    };

    const first = await client.rpc('record_client_payment', payload);
    expect(first.error).toBeNull();
    expect((first.data as { fully_settled: boolean }).fully_settled).toBe(true);

    // Exact replay — simulates the outbox retrying after the original call's
    // response never reached the device (network drop mid-response).
    const second = await client.rpc('record_client_payment', payload);
    expect(second.error).toBeNull();
    expect((second.data as { fully_settled: boolean }).fully_settled).toBe(true);

    const state = await saleState(orderId);
    expect(state.status).toBe('paye');
    // The real assertion: exactly ONE payment of 1000000 cents was applied,
    // not two. If the idempotency claim failed to prevent the second call
    // from re-allocating, this would read 2000000 (double-paid) — real
    // money invented against a debt that was only ever actually settled once.
    expect(state.amountPaid).toBe(1000000);
  });

  it('a partial payment retried with the same key allocates only once, leaving the correct remaining balance', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const orderId = await creditSale(client, businessId, userId, 'Ousmane', 1000000); // 10000 GNF

    const idempotencyKey = randomUUID();
    const payload = {
      p_business_id: businessId,
      p_customer_name: 'Ousmane',
      p_amount: 400000, // partial: 4000 of 10000 GNF
      p_method: 'especes',
      p_date: '2026-09-28',
      p_idempotency_key: idempotencyKey,
    };

    await client.rpc('record_client_payment', payload);
    const replay = await client.rpc('record_client_payment', payload);
    expect(replay.error).toBeNull();
    expect((replay.data as { fully_settled: boolean }).fully_settled).toBe(false); // still owes 6000

    const state = await saleState(orderId);
    expect(state.status).toBe('credit'); // not fully paid
    expect(state.amountPaid).toBe(400000); // exactly one allocation, not 800000
  });

  it('two DIFFERENT idempotency keys for two genuinely separate payments both apply (idempotency never blocks a real second payment)', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const orderId = await creditSale(client, businessId, userId, 'Mamadou', 1000000);

    const first = await client.rpc('record_client_payment', {
      p_business_id: businessId, p_customer_name: 'Mamadou', p_amount: 300000,
      p_method: 'especes', p_date: '2026-09-28', p_idempotency_key: randomUUID(),
    });
    expect(first.error).toBeNull();

    const second = await client.rpc('record_client_payment', {
      p_business_id: businessId, p_customer_name: 'Mamadou', p_amount: 300000,
      p_method: 'especes', p_date: '2026-09-29', p_idempotency_key: randomUUID(),
    });
    expect(second.error).toBeNull();

    const state = await saleState(orderId);
    expect(state.amountPaid).toBe(600000); // both genuinely separate payments landed
  });

  it('a caller with no idempotency key at all (p_idempotency_key omitted) still works — backward compatible', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const orderId = await creditSale(client, businessId, userId, 'Fatou', 500000);

    const { error, data } = await client.rpc('record_client_payment', {
      p_business_id: businessId, p_customer_name: 'Fatou', p_amount: 500000,
      p_method: 'especes', p_date: '2026-09-28',
    });
    expect(error).toBeNull();
    expect((data as { fully_settled: boolean }).fully_settled).toBe(true);
    expect((await saleState(orderId)).amountPaid).toBe(500000);
  });
});
