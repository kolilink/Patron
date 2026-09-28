// Exercises the real submit_quick_sale() Postgres function (migration_v190)
// against a live Postgres instance — the "Vente rapide" quick-sale mode of
// the rapid capture sheet (see CLAUDE.md's "Quick sale redesign" note). The
// whole point of this RPC is a hard product rule: "Pas de produit, pas de
// quantité [inventée]" — a quick sale can carry a real quantity and an
// optional free-text label the merchant actually typed, but must never
// create a real, visible catalog product or move real inventory the way the
// old name-typing "Nouvelle vente" form did. These tests verify that rule
// directly against real rows, not just that the client calls the RPC with
// the right params — only a live database can tell a real is_system
// placeholder apart from a real catalog product.
import { createTestUser, createTestBusiness, addMember, adminClient } from './helpers';
import { randomUUID } from 'crypto';

describe('submit_quick_sale — real RPC', () => {
  it('records one paid sale with no real catalog product and no stock movement (qty=1, no label)', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const admin = adminClient();

    const { data: productsBefore } = await admin.from('products').select('id').eq('business_id', businessId);
    expect(productsBefore ?? []).toHaveLength(0);

    const { data: orderId, error } = await client.rpc('submit_quick_sale', {
      p_business_id: businessId,
      p_seller_id: userId,
      p_unit_price: 500000, // 5000 GNF in cents
    });
    expect(error).toBeNull();

    const { data: order } = await admin
      .from('sale_orders')
      .select('status, is_credit, total_amount, discount_amount, paid_at')
      .eq('id', orderId as string)
      .single();
    expect(order?.status).toBe('paye');
    expect(order?.is_credit).toBe(false);
    expect(order?.total_amount).toBe(500000);
    expect(order?.discount_amount).toBe(0);
    expect(order?.paid_at).not.toBeNull();

    const { data: lines } = await admin.from('so_lines').select('product_id, product_name, qty, unit_price').eq('order_id', orderId as string);
    expect(lines).toHaveLength(1);
    expect(lines?.[0].qty).toBe(1);
    expect(lines?.[0].unit_price).toBe(500000);
    // No label given — falls back to the placeholder's own name, never blank.
    expect(lines?.[0].product_name).toBe('Vente rapide');

    // The line's product exists (FK requires it) but must be the hidden
    // system placeholder, never a real catalog entry.
    const { data: product } = await admin.from('products').select('name, is_system, stock_qty').eq('id', lines?.[0].product_id as string).single();
    expect(product?.is_system).toBe(true);
    expect(product?.name).toBe('Vente rapide');

    // "Zero product rows" per the acceptance criteria means zero NEW/real
    // ones — the one row that exists is the hidden placeholder, and it's
    // the only row in the table at all after this single sale.
    const { data: productsAfter } = await admin.from('products').select('id, is_system').eq('business_id', businessId);
    expect(productsAfter).toHaveLength(1);
    expect(productsAfter?.[0].is_system).toBe(true);

    // Zero stock movements — this sale must never touch inventory.
    const { data: moves } = await admin.from('stock_moves').select('id').eq('business_id', businessId);
    expect(moves ?? []).toHaveLength(0);

    // A real payments row backs the "paid" status — method 'especes' (cash),
    // the fixed default this mode always uses (no payment picker).
    const { data: payments } = await admin.from('payments').select('method, amount').eq('order_id', orderId as string);
    expect(payments).toHaveLength(1);
    expect(payments?.[0].method).toBe('especes');
    expect(payments?.[0].amount).toBe(500000);
  });

  it('records a real quantity and an optional label, with the total computed server-side as qty × unit price', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const admin = adminClient();

    const { data: orderId, error } = await client.rpc('submit_quick_sale', {
      p_business_id: businessId,
      p_seller_id: userId,
      p_unit_price: 150000, // 1500 GNF/unit
      p_qty: 3,
      p_label: 'Riz, sac de 5kg',
    });
    expect(error).toBeNull();

    const { data: order } = await admin.from('sale_orders').select('total_amount').eq('id', orderId as string).single();
    expect(order?.total_amount).toBe(450000); // 150000 * 3, never trusted from a client-supplied total

    const { data: lines } = await admin.from('so_lines').select('product_name, qty, unit_price').eq('order_id', orderId as string);
    expect(lines).toHaveLength(1);
    expect(lines?.[0].qty).toBe(3);
    expect(lines?.[0].unit_price).toBe(150000);
    expect(lines?.[0].product_name).toBe('Riz, sac de 5kg');

    const { data: payments } = await admin.from('payments').select('amount').eq('order_id', orderId as string);
    expect(payments?.[0].amount).toBe(450000);

    // Still zero real products and zero stock movements — a real quantity
    // recorded on the line is not the same thing as a tracked inventory qty.
    const { data: products } = await admin.from('products').select('id, is_system').eq('business_id', businessId);
    expect(products).toHaveLength(1);
    expect(products?.[0].is_system).toBe(true);
    const { data: moves } = await admin.from('stock_moves').select('id').eq('business_id', businessId);
    expect(moves ?? []).toHaveLength(0);
  });

  it('a blank/whitespace-only label falls back to the placeholder name, same as omitting it', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const admin = adminClient();

    const { data: orderId, error } = await client.rpc('submit_quick_sale', {
      p_business_id: businessId, p_seller_id: userId, p_unit_price: 100000, p_label: '   ',
    });
    expect(error).toBeNull();

    const { data: lines } = await admin.from('so_lines').select('product_name').eq('order_id', orderId as string);
    expect(lines?.[0].product_name).toBe('Vente rapide');
  });

  it('reuses the same placeholder product across repeated quick sales — never creates a second one', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const admin = adminClient();

    for (const unitPrice of [100000, 250000, 75000]) {
      const { error } = await client.rpc('submit_quick_sale', {
        p_business_id: businessId, p_seller_id: userId, p_unit_price: unitPrice,
      });
      expect(error).toBeNull();
    }

    const { data: sales } = await admin.from('sale_orders').select('id').eq('business_id', businessId);
    expect(sales).toHaveLength(3);

    const { data: products } = await admin.from('products').select('id').eq('business_id', businessId).eq('is_system', true);
    expect(products).toHaveLength(1); // get-or-create, not create-every-time

    const { data: moves } = await admin.from('stock_moves').select('id').eq('business_id', businessId);
    expect(moves ?? []).toHaveLength(0);
  });

  it('is idempotent — the same idempotency key never creates a second sale', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const key = randomUUID();

    const { data: firstId, error: err1 } = await client.rpc('submit_quick_sale', {
      p_business_id: businessId, p_seller_id: userId, p_unit_price: 300000, p_idempotency_key: key,
    });
    expect(err1).toBeNull();

    const { data: secondId, error: err2 } = await client.rpc('submit_quick_sale', {
      p_business_id: businessId, p_seller_id: userId, p_unit_price: 300000, p_idempotency_key: key,
    });
    expect(err2).toBeNull();
    expect(secondId).toBe(firstId);

    const admin = adminClient();
    const { data: sales } = await admin.from('sale_orders').select('id').eq('business_id', businessId);
    expect(sales).toHaveLength(1);
  });

  it('rejects a negative or zero unit price', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');

    const { error: zeroErr } = await client.rpc('submit_quick_sale', {
      p_business_id: businessId, p_seller_id: userId, p_unit_price: 0,
    });
    expect(zeroErr).not.toBeNull();

    const { error: negErr } = await client.rpc('submit_quick_sale', {
      p_business_id: businessId, p_seller_id: userId, p_unit_price: -50000,
    });
    expect(negErr).not.toBeNull();
  });

  it('rejects a negative or zero quantity', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');

    const { error: zeroErr } = await client.rpc('submit_quick_sale', {
      p_business_id: businessId, p_seller_id: userId, p_unit_price: 100000, p_qty: 0,
    });
    expect(zeroErr).not.toBeNull();

    const { error: negErr } = await client.rpc('submit_quick_sale', {
      p_business_id: businessId, p_seller_id: userId, p_unit_price: 100000, p_qty: -2,
    });
    expect(negErr).not.toBeNull();
  });

  it('a vendeur can only record a quick sale under their own seller_id', async () => {
    const { client: adminC, userId: adminId } = await createTestUser('admin');
    const businessId = await createTestBusiness(adminC, 'Boutique Test');
    const { client: vendeurC, userId: vendeurId } = await createTestUser('vendeur');
    await addMember(businessId, vendeurId, 'vendeur');

    const { error: ownSale } = await vendeurC.rpc('submit_quick_sale', {
      p_business_id: businessId, p_seller_id: vendeurId, p_unit_price: 150000,
    });
    expect(ownSale).toBeNull();

    const { error: impersonation } = await vendeurC.rpc('submit_quick_sale', {
      p_business_id: businessId, p_seller_id: adminId, p_unit_price: 150000,
    });
    expect(impersonation).not.toBeNull();
  });

  it('rejects an investisseur entirely — read-only role, no write path', async () => {
    const { client: adminC } = await createTestUser('admin');
    const businessId = await createTestBusiness(adminC, 'Boutique Test');
    const { client: investorC, userId: investorId } = await createTestUser('investor');
    await addMember(businessId, investorId, 'investisseur');

    const { error } = await investorC.rpc('submit_quick_sale', {
      p_business_id: businessId, p_seller_id: investorId, p_unit_price: 150000,
    });
    expect(error).not.toBeNull();
  });

  it('get_best_sellers never surfaces the is_system placeholder, even after real quick sales', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const admin = adminClient();

    await client.rpc('submit_quick_sale', { p_business_id: businessId, p_seller_id: userId, p_unit_price: 900000 });
    await client.rpc('submit_carnet_debt', {
      p_business_id: businessId, p_seller_id: userId, p_customer_name: 'Test', p_amount: 400000,
    });

    // A real catalog product too, so the ranking isn't just trivially empty.
    const realProductId = randomUUID();
    await admin.from('products').insert({
      id: realProductId, business_id: businessId, name: 'Riz local', unit: 'sac',
      stock_qty: 50, cost_price: 10000, sale_price: 20000, reorder_level: 0, created_by: userId,
    });
    const { data: saleId } = await client.rpc('submit_sale', {
      p_business_id: businessId, p_seller_id: userId,
      p_cart: [{ product_id: realProductId, product_name: 'Riz local', qty: 1, unit_price: 20000 }],
      p_pay_method: 'especes', p_pay_amount: 20000,
    });
    expect(saleId).not.toBeNull();

    const { data: bestSellers, error } = await client.rpc('get_best_sellers', {
      p_business_id: businessId,
      p_month_start: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10),
      p_limit: 10,
    });
    expect(error).toBeNull();
    const names = (bestSellers ?? []).map((r: { product_name: string }) => r.product_name);
    expect(names).not.toContain('Vente rapide');
    expect(names).not.toContain('Solde reporté');
    expect(names).toContain('Riz local');
  });
});
