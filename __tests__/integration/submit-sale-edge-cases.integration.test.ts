// Security audit 2026-09-27, checklist 1.8 fuzz/edge-case pass — submit_sale
// is the single highest-volume, highest-blast-radius write in the app, and
// until now nobody had actually thrown malformed/adversarial cart shapes at
// it, only well-formed ones (see submit-sale.integration.test.ts). This
// file's job is to find out what's actually true, not what should be true —
// some of these assertions describe bugs at the time they were written and
// are expected to start passing only after a fix lands (see each test's own
// comment for whether it's asserting a bug or confirming safe behavior).
import { randomUUID } from 'crypto';
import {
  createTestUser, createTestBusiness, createTestProduct, getProductStock,
} from './helpers';

describe('submit_sale — edge cases and adversarial input', () => {
  it('negative quantity: does NOT increase stock or accept the line (fixed — was a real bug)', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const productId = await createTestProduct(businessId, userId, { stock_qty: 10, sale_price: 1000, cost_price: 500 });

    const { error } = await client.rpc('submit_sale', {
      p_business_id: businessId,
      p_seller_id: userId,
      p_cart: [{ product_id: productId, product_name: 'x', qty: -5, unit_price: 1000 }],
      p_total_amount: -5000,
      p_pay_method: 'especes',
      p_pay_amount: -5000,
    });

    expect(error).toBeTruthy();
    expect(error!.message).toMatch(/Quantité invalide/);
    expect(await getProductStock(productId)).toBe(10); // unchanged, not 15
  });

  it('zero quantity: rejected outright rather than creating a meaningless line (fixed)', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const productId = await createTestProduct(businessId, userId, { stock_qty: 10 });

    const { error } = await client.rpc('submit_sale', {
      p_business_id: businessId,
      p_seller_id: userId,
      p_cart: [{ product_id: productId, product_name: 'x', qty: 0, unit_price: 1000 }],
      p_total_amount: 0,
    });

    expect(error).toBeTruthy();
    expect(error!.message).toMatch(/Quantité invalide/);
    expect(await getProductStock(productId)).toBe(10);
  });

  it('empty cart: rejected — a sale needs at least one line (fixed)', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');

    const { error } = await client.rpc('submit_sale', {
      p_business_id: businessId,
      p_seller_id: userId,
      p_cart: [],
      p_total_amount: 0,
    });

    expect(error).toBeTruthy();
    expect(error!.message).toMatch(/[Aa]u moins un article/);
  });

  it("cross-business product_id: cannot deduct another business's stock (fixed — was a real cross-tenant bug)", async () => {
    const { client: victimC, userId: victimUserId } = await createTestUser('victim');
    const victimBusinessId = await createTestBusiness(victimC, 'Boutique Victime');
    const victimProductId = await createTestProduct(victimBusinessId, victimUserId, { stock_qty: 50, sale_price: 2000, cost_price: 1000 });

    const { client: attackerC, userId: attackerUserId } = await createTestUser('attacker');
    const attackerBusinessId = await createTestBusiness(attackerC, 'Boutique Attaquant');

    const { error } = await attackerC.rpc('submit_sale', {
      p_business_id: attackerBusinessId,
      p_seller_id: attackerUserId,
      p_cart: [{ product_id: victimProductId, product_name: 'x', qty: 10, unit_price: 2000 }],
      p_total_amount: 20000,
    });

    expect(error).toBeTruthy();
    expect(await getProductStock(victimProductId)).toBe(50); // untouched
  });

  it('duplicate lines for the same product: deducts the sum of both lines correctly (confirmed safe, no fix needed)', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const productId = await createTestProduct(businessId, userId, { stock_qty: 20, sale_price: 1000, cost_price: 500 });

    const { error } = await client.rpc('submit_sale', {
      p_business_id: businessId,
      p_seller_id: userId,
      p_cart: [
        { product_id: productId, product_name: 'x', qty: 3, unit_price: 1000 },
        { product_id: productId, product_name: 'x', qty: 2, unit_price: 1000 },
      ],
      p_total_amount: 5000,
    });

    expect(error).toBeNull();
    expect(await getProductStock(productId)).toBe(15); // 20 - 3 - 2
  });

  it('a cart line missing unit_price entirely is rejected cleanly, nothing persisted (confirmed safe)', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const productId = await createTestProduct(businessId, userId, { stock_qty: 10 });

    const { error } = await client.rpc('submit_sale', {
      p_business_id: businessId,
      p_seller_id: userId,
      p_cart: [{ product_id: productId, product_name: 'x', qty: 1 }], // no unit_price
      p_total_amount: 0,
    });

    expect(error).toBeTruthy();
    expect(await getProductStock(productId)).toBe(10); // rolled back, not partially applied

    const { data: orders } = await client.from('sale_orders').select('id').eq('business_id', businessId);
    expect(orders).toHaveLength(0); // no orphaned sale_orders row either
  });

  it('a product_id that does not exist at all is rejected cleanly (confirmed safe)', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');

    const { error } = await client.rpc('submit_sale', {
      p_business_id: businessId,
      p_seller_id: userId,
      p_cart: [{ product_id: randomUUID(), product_name: 'x', qty: 1, unit_price: 1000 }],
      p_total_amount: 1000,
    });

    expect(error).toBeTruthy();
    const { data: orders } = await client.from('sale_orders').select('id').eq('business_id', businessId);
    expect(orders).toHaveLength(0);
  });
});
