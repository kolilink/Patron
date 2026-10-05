// Réception through the offline outbox (migration_v229): confirm_reception
// takes an idempotency key, so a replayed drain can never book a delivery
// twice. Real RPC, real Postgres.
import { randomUUID } from 'crypto';
import { createTestUser, createTestBusiness, createTestProduct, adminClient, getProductStock } from './helpers';

async function counts(businessId: string, productId: string) {
  const admin = adminClient();
  const { data: pos } = await admin.from('purchase_orders').select('id').eq('business_id', businessId);
  const { data: moves } = await admin.from('stock_moves').select('qty').eq('business_id', businessId).eq('product_id', productId).eq('type', 'entree');
  const { data: exp } = await admin.from('expenses').select('id').eq('business_id', businessId).eq('category', 'transport_achat');
  return { orders: pos?.length ?? 0, entrees: moves?.length ?? 0, transport: exp?.length ?? 0, stock: await getProductStock(productId) };
}

describe('confirm_reception — idempotency (migration_v229)', () => {
  it('replaying the same key books ONE delivery: one order, one stock entry, one transport expense', async () => {
    const { client, userId } = await createTestUser('recv-a');
    const businessId = await createTestBusiness(client, 'Boutique Réception');
    const productId = await createTestProduct(businessId, userId, { sale_price: 500000, stock_qty: 0 });
    const key = randomUUID();
    const args = {
      p_business_id: businessId,
      p_lines: [{ product_id: productId, name: 'Riz', qty: 10, unit_cost_cents: 300000 }],
      p_transport_cost_cents: 50000,
      p_idempotency_key: key,
    };

    const first = await client.rpc('confirm_reception', args);
    expect(first.error).toBeNull();
    const second = await client.rpc('confirm_reception', args);   // the drain retries
    const third = await client.rpc('confirm_reception', args);
    expect(second.error).toBeNull();
    expect(third.error).toBeNull();

    expect(first.data).toBe(key);                  // a new order's id IS the key: the offline client already knew it
    expect(second.data).toBe(first.data);
    expect(third.data).toBe(first.data);

    const c = await counts(businessId, productId);
    expect(c).toEqual({ orders: 1, entrees: 1, transport: 1, stock: 10 });
  });

  it('two DIFFERENT keys are two receptions (the key is the only identity)', async () => {
    const { client, userId } = await createTestUser('recv-b');
    const businessId = await createTestBusiness(client, 'Boutique Deux');
    const productId = await createTestProduct(businessId, userId, { sale_price: 500000, stock_qty: 0 });
    const line = [{ product_id: productId, name: 'Riz', qty: 4, unit_cost_cents: 100000 }];
    expect((await client.rpc('confirm_reception', { p_business_id: businessId, p_lines: line, p_idempotency_key: randomUUID() })).error).toBeNull();
    expect((await client.rpc('confirm_reception', { p_business_id: businessId, p_lines: line, p_idempotency_key: randomUUID() })).error).toBeNull();
    expect((await counts(businessId, productId)).stock).toBe(8);
  });

  it('concurrent replays of one key still book once', async () => {
    const { client, userId } = await createTestUser('recv-c');
    const businessId = await createTestBusiness(client, 'Boutique Course');
    const productId = await createTestProduct(businessId, userId, { sale_price: 500000, stock_qty: 0 });
    const key = randomUUID();
    const args = { p_business_id: businessId, p_lines: [{ product_id: productId, name: 'Riz', qty: 3, unit_cost_cents: 100000 }], p_idempotency_key: key };
    const results = await Promise.all([1, 2, 3].map(() => client.rpc('confirm_reception', args)));
    for (const r of results) expect(r.error).toBeNull();
    expect(new Set(results.map(r => r.data)).size).toBe(1);
    const c = await counts(businessId, productId);
    expect(c.orders).toBe(1);
    expect(c.stock).toBe(3);
  });

  it('no key still works exactly as before (older clients / direct callers)', async () => {
    const { client, userId } = await createTestUser('recv-d');
    const businessId = await createTestBusiness(client, 'Boutique Ancienne');
    const productId = await createTestProduct(businessId, userId, { sale_price: 500000, stock_qty: 0 });
    const r = await client.rpc('confirm_reception', { p_business_id: businessId, p_lines: [{ product_id: productId, name: 'Riz', qty: 2, unit_cost_cents: 100000 }] });
    expect(r.error).toBeNull();
    expect(r.data).toBeTruthy();
    expect((await counts(businessId, productId)).stock).toBe(2);
  });

  it('a key is scoped to its business: it cannot replay across businesses', async () => {
    const a = await createTestUser('recv-e1');
    const b = await createTestUser('recv-e2');
    const bizA = await createTestBusiness(a.client, 'A');
    const bizB = await createTestBusiness(b.client, 'B');
    const prodA = await createTestProduct(bizA, a.userId, { sale_price: 500000, stock_qty: 0 });
    const prodB = await createTestProduct(bizB, b.userId, { sale_price: 500000, stock_qty: 0 });
    const key = randomUUID();
    expect((await a.client.rpc('confirm_reception', { p_business_id: bizA, p_lines: [{ product_id: prodA, name: 'x', qty: 1, unit_cost_cents: 1 }], p_idempotency_key: key })).error).toBeNull();
    // Same key from another business: not treated as a replay of A's order (and not allowed to hijack it).
    const r = await b.client.rpc('confirm_reception', { p_business_id: bizB, p_lines: [{ product_id: prodB, name: 'x', qty: 1, unit_cost_cents: 1 }], p_idempotency_key: key });
    expect(r.error).not.toBeNull();     // the new order's id (= key) already exists elsewhere: a clean failure, not a cross-tenant write
    expect((await counts(bizB, prodB)).stock).toBe(0);
  });

  it('a non-member cannot use it', async () => {
    const owner = await createTestUser('recv-f1');
    const other = await createTestUser('recv-f2');
    const biz = await createTestBusiness(owner.client, 'F');
    const prod = await createTestProduct(biz, owner.userId, { sale_price: 500000, stock_qty: 0 });
    const r = await other.client.rpc('confirm_reception', { p_business_id: biz, p_lines: [{ product_id: prod, name: 'x', qty: 1, unit_cost_cents: 1 }], p_idempotency_key: randomUUID() });
    expect(r.error).not.toBeNull();
    expect((await counts(biz, prod)).stock).toBe(0);
  });
});
