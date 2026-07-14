// Exercises the real submit_sale() Postgres function against a local
// Supabase instance — unlike __tests__/submit-sale.test.ts (which mocks
// supabase.rpc entirely), this catches regressions in the SQL itself:
// stock deduction, atomic rollback on insufficient stock, idempotency,
// and role/RLS enforcement.
import { randomUUID } from 'crypto';
import {
  createTestUser, createTestBusiness, addMember, createTestProduct, getProductStock,
} from './helpers';

describe('submit_sale (real RPC)', () => {
  it('deducts stock and creates order + lines + payment + stock_moves', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const productId = await createTestProduct(businessId, userId, { stock_qty: 10, sale_price: 1000, cost_price: 500 });

    const { data: orderId, error } = await client.rpc('submit_sale', {
      p_business_id: businessId,
      p_seller_id: userId,
      p_cart: [{ product_id: productId, product_name: 'Produit test', qty: 3, unit_price: 1000 }],
      p_total_amount: 3000,
      p_pay_method: 'especes',
      p_pay_amount: 3000,
    });

    expect(error).toBeNull();
    expect(orderId).toBeTruthy();
    expect(await getProductStock(productId)).toBe(7);

    const { data: lines } = await client.from('so_lines').select('*').eq('order_id', orderId);
    expect(lines).toHaveLength(1);
    expect(lines![0].qty).toBe(3);

    const { data: payments } = await client.from('payments').select('*').eq('order_id', orderId);
    expect(payments).toHaveLength(1);
    expect(payments![0].amount).toBe(3000);

    const { data: moves } = await client.from('stock_moves').select('*').eq('ref_id', orderId);
    expect(moves).toHaveLength(1);
    expect(moves![0].type).toBe('sortie');
  });

  it('rolls back the whole sale when stock is insufficient (regression: v51)', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const productId = await createTestProduct(businessId, userId, { stock_qty: 2, sale_price: 1000, cost_price: 500 });

    const { error } = await client.rpc('submit_sale', {
      p_business_id: businessId,
      p_seller_id: userId,
      p_cart: [{ product_id: productId, product_name: 'Produit test', qty: 5, unit_price: 1000 }],
      p_total_amount: 5000,
      p_pay_method: 'especes',
      p_pay_amount: 5000,
    });

    expect(error).toBeTruthy();
    expect(error!.message).toMatch(/Stock insuffisant/);

    // Nothing should have been committed: stock unchanged, no order left behind.
    expect(await getProductStock(productId)).toBe(2);
    const { data: orders } = await client.from('sale_orders').select('id').eq('business_id', businessId);
    expect(orders).toHaveLength(0);
  });

  it('is idempotent — retrying with the same idempotency key returns the same order, no double stock deduction', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const productId = await createTestProduct(businessId, userId, { stock_qty: 10, sale_price: 1000, cost_price: 500 });
    const idempotencyKey = randomUUID();

    const cart = [{ product_id: productId, product_name: 'Produit test', qty: 2, unit_price: 1000 }];
    const first = await client.rpc('submit_sale', {
      p_business_id: businessId, p_seller_id: userId, p_cart: cart,
      p_total_amount: 2000, p_pay_method: 'especes', p_pay_amount: 2000,
      p_idempotency_key: idempotencyKey,
    });
    const second = await client.rpc('submit_sale', {
      p_business_id: businessId, p_seller_id: userId, p_cart: cart,
      p_total_amount: 2000, p_pay_method: 'especes', p_pay_amount: 2000,
      p_idempotency_key: idempotencyKey,
    });

    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(second.data).toBe(first.data);
    expect(await getProductStock(productId)).toBe(8); // deducted once, not twice
  });

  it('rejects a vendeur submitting a sale under someone else\'s name', async () => {
    const { client: adminC, userId: adminId } = await createTestUser('admin');
    const businessId = await createTestBusiness(adminC, 'Boutique Test');
    const productId = await createTestProduct(businessId, adminId, { stock_qty: 10 });

    const { client: vendeurC, userId: vendeurId } = await createTestUser('vendeur');
    await addMember(businessId, vendeurId, 'vendeur');

    const { error } = await vendeurC.rpc('submit_sale', {
      p_business_id: businessId,
      p_seller_id: adminId, // impersonating the admin
      p_cart: [{ product_id: productId, product_name: 'x', qty: 1, unit_price: 1000 }],
      p_total_amount: 1000, p_pay_method: 'especes', p_pay_amount: 1000,
    });

    expect(error).toBeTruthy();
    expect(error!.message).toMatch(/propres ventes/);
  });

  it('rejects an investisseur (read-only role) from submitting a sale', async () => {
    const { client: adminC, userId: adminId } = await createTestUser('admin');
    const businessId = await createTestBusiness(adminC, 'Boutique Test');
    const productId = await createTestProduct(businessId, adminId, { stock_qty: 10 });

    const { client: investorC, userId: investorId } = await createTestUser('investisseur');
    await addMember(businessId, investorId, 'investisseur');

    const { error } = await investorC.rpc('submit_sale', {
      p_business_id: businessId,
      p_seller_id: investorId,
      p_cart: [{ product_id: productId, product_name: 'x', qty: 1, unit_price: 1000 }],
      p_total_amount: 1000, p_pay_method: 'especes', p_pay_amount: 1000,
    });

    expect(error).toBeTruthy();
    expect(error!.message).toMatch(/Accès refusé/);
  });
});
