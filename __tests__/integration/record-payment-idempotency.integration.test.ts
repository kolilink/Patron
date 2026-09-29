// record_payment (singular, per-sale) gains real idempotency, mirroring
// migration_v203's fix to record_client_payment — see migration_v205's
// own header comment for why. record_payment always inserts exactly ONE
// `payments` row per call against one already-known sale_id (unlike
// record_client_payment's FIFO fan-out), so this uses a nullable
// idempotency_key column + partial unique index on `payments` itself,
// the same shape submit_sale's idempotency_key already uses on
// sale_orders (migration_v26).
//
// This is the prerequisite for converting stores/ventes.ts's recordPayment
// to local-write-first — without it, an outbox retry of the exact same
// payment (a drain retry after a partial network failure) could double-
// insert real money against the sale. Verified against a real local
// Postgres instance, not mocked.
import { randomUUID } from 'crypto';
import { createTestUser, createTestBusiness, createTestProduct, adminClient } from './helpers';

async function creditSale(client: ReturnType<typeof adminClient>, businessId: string, sellerId: string, customerName: string, productId: string, amountCents: number) {
  const { data: orderId, error } = await client.rpc('submit_sale', {
    p_business_id: businessId,
    p_seller_id: sellerId,
    p_customer_name: customerName,
    p_sale_date: '2026-09-28',
    p_total_amount: amountCents,
    p_discount_amount: 0,
    p_is_credit: true,
    p_cart: [{ product_id: productId, qty: 1, unit_price: amountCents, is_bulk: false }],
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

describe('record_payment — idempotency (real RPC, migration_v205)', () => {
  it('replaying the exact same call with the same idempotency key does not double-insert the payment', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const productId = await createTestProduct(businessId, userId, { sale_price: 1000000 });
    const orderId = await creditSale(client, businessId, userId, 'Aissatou', productId, 1000000);

    const idempotencyKey = randomUUID();
    const payload = {
      p_sale_id: orderId,
      p_business_id: businessId,
      p_amount: 1000000,
      p_method: 'especes',
      p_date: '2026-09-28',
      p_idempotency_key: idempotencyKey,
    };

    const first = await client.rpc('record_payment', payload);
    expect(first.error).toBeNull();
    expect(first.data).toBe(true);

    // Exact replay — simulates the outbox retrying after the original
    // call's response never reached the device.
    const second = await client.rpc('record_payment', payload);
    expect(second.error).toBeNull();
    expect(second.data).toBe(true);

    const state = await saleState(orderId);
    expect(state.status).toBe('paye');
    // The real assertion: exactly one payment landed, not two.
    expect(state.amountPaid).toBe(1000000);
  });

  it('a partial payment retried with the same key applies only once', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const productId = await createTestProduct(businessId, userId, { sale_price: 1000000 });
    const orderId = await creditSale(client, businessId, userId, 'Ousmane', productId, 1000000);

    const idempotencyKey = randomUUID();
    const payload = {
      p_sale_id: orderId,
      p_business_id: businessId,
      p_amount: 400000,
      p_method: 'especes',
      p_date: '2026-09-28',
      p_idempotency_key: idempotencyKey,
    };

    await client.rpc('record_payment', payload);
    const replay = await client.rpc('record_payment', payload);
    expect(replay.error).toBeNull();
    expect(replay.data).toBe(false); // still owes 600000

    const state = await saleState(orderId);
    expect(state.status).toBe('credit');
    expect(state.amountPaid).toBe(400000); // exactly one allocation, not 800000
  });

  it('two DIFFERENT idempotency keys for two genuinely separate payments both apply', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const productId = await createTestProduct(businessId, userId, { sale_price: 1000000 });
    const orderId = await creditSale(client, businessId, userId, 'Mamadou', productId, 1000000);

    const first = await client.rpc('record_payment', {
      p_sale_id: orderId, p_business_id: businessId, p_amount: 300000,
      p_method: 'especes', p_date: '2026-09-28', p_idempotency_key: randomUUID(),
    });
    expect(first.error).toBeNull();

    const second = await client.rpc('record_payment', {
      p_sale_id: orderId, p_business_id: businessId, p_amount: 300000,
      p_method: 'especes', p_date: '2026-09-29', p_idempotency_key: randomUUID(),
    });
    expect(second.error).toBeNull();

    const state = await saleState(orderId);
    expect(state.amountPaid).toBe(600000); // both genuinely separate payments landed
  });

  it('a caller with no idempotency key at all still works — backward compatible', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const productId = await createTestProduct(businessId, userId, { sale_price: 1000000 });
    const orderId = await creditSale(client, businessId, userId, 'Fatou', productId, 500000);

    const { error, data } = await client.rpc('record_payment', {
      p_sale_id: orderId, p_business_id: businessId, p_amount: 500000,
      p_method: 'especes', p_date: '2026-09-28',
    });
    expect(error).toBeNull();
    expect(data).toBe(true);
    expect((await saleState(orderId)).amountPaid).toBe(500000);
  });

  it('rejects an overpayment attempt even when replaying under a fresh idempotency key', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const productId = await createTestProduct(businessId, userId, { sale_price: 1000000 });
    const orderId = await creditSale(client, businessId, userId, 'Sekou', productId, 500000);

    await client.rpc('record_payment', {
      p_sale_id: orderId, p_business_id: businessId, p_amount: 500000,
      p_method: 'especes', p_date: '2026-09-28', p_idempotency_key: randomUUID(),
    });

    const overpay = await client.rpc('record_payment', {
      p_sale_id: orderId, p_business_id: businessId, p_amount: 100000,
      p_method: 'especes', p_date: '2026-09-29', p_idempotency_key: randomUUID(),
    });
    expect(overpay.error).not.toBeNull();
  });
});
