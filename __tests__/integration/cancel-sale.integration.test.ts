// Exercises the real cancel_sale() Postgres function — stock restoration,
// payment cleanup, idempotent re-cancellation, and own-sale-only enforcement
// for vendeurs.
import {
  createTestUser, createTestBusiness, addMember, createTestProduct, createTestVariant, getProductStock,
} from './helpers';

async function submitSale(client: any, businessId: string, userId: string, productId: string, qty: number) {
  const { data: orderId, error } = await client.rpc('submit_sale', {
    p_business_id: businessId,
    p_seller_id: userId,
    p_cart: [{ product_id: productId, product_name: 'Produit test', qty, unit_price: 1000 }],
    p_total_amount: qty * 1000,
    p_pay_method: 'especes',
    p_pay_amount: qty * 1000,
  });
  if (error) throw error;
  return orderId as string;
}

describe('cancel_sale (real RPC)', () => {
  it('restores stock and deletes the payment (regression: v100)', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const productId = await createTestProduct(businessId, userId, { stock_qty: 10 });

    const orderId = await submitSale(client, businessId, userId, productId, 3);
    expect(await getProductStock(productId)).toBe(7);

    const { data: ok, error } = await client.rpc('cancel_sale', {
      p_sale_id: orderId, p_business_id: businessId, p_reason: 'Erreur',
    });

    expect(error).toBeNull();
    expect(ok).toBe(true);
    expect(await getProductStock(productId)).toBe(10);

    const { data: payments } = await client.from('payments').select('*').eq('order_id', orderId);
    expect(payments).toHaveLength(0);
  });

  it('is idempotent — cancelling an already-cancelled sale does not double-restore stock', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const productId = await createTestProduct(businessId, userId, { stock_qty: 10 });
    const orderId = await submitSale(client, businessId, userId, productId, 3);

    await client.rpc('cancel_sale', { p_sale_id: orderId, p_business_id: businessId, p_reason: 'Erreur' });
    const second = await client.rpc('cancel_sale', { p_sale_id: orderId, p_business_id: businessId, p_reason: 'Erreur encore' });

    expect(second.error).toBeNull();
    expect(second.data).toBe(true);
    expect(await getProductStock(productId)).toBe(10); // not 13
  });

  it('rejects a vendeur cancelling another vendeur\'s sale', async () => {
    const { client: adminC, userId: adminId } = await createTestUser('admin');
    const businessId = await createTestBusiness(adminC, 'Boutique Test');
    const productId = await createTestProduct(businessId, adminId, { stock_qty: 10 });

    const { client: sellerC, userId: sellerId } = await createTestUser('vendeur1');
    await addMember(businessId, sellerId, 'vendeur');
    const orderId = await submitSale(sellerC, businessId, sellerId, productId, 2);

    const { client: otherC, userId: otherId } = await createTestUser('vendeur2');
    await addMember(businessId, otherId, 'vendeur');

    const { error } = await otherC.rpc('cancel_sale', {
      p_sale_id: orderId, p_business_id: businessId, p_reason: 'Erreur',
    });

    expect(error).toBeTruthy();
    expect(error!.message).toMatch(/propres ventes/);
    expect(await getProductStock(productId)).toBe(8); // untouched
  });

  // submit_sale's own comment says it plainly: "Variant product: guard is on
  // product_variants (parent products.stock_qty is always 0 for variant
  // parents so no meaningful guard there)." cancel_sale's stock-restore loop
  // doesn't honor that invariant — it unconditionally adds the cancelled
  // qty back onto the PARENT's stock_qty in addition to the variant's, for
  // every line, variant or not. Over repeated variant sales + cancellations
  // this silently drifts the parent's stock_qty away from 0.
  it('does not drift the parent product\'s stock_qty for a variant sale (found via this test — see CLAUDE.md note)', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const productId = await createTestProduct(businessId, userId, { name: 'T-shirt' });
    const variantId = await createTestVariant(productId, businessId, { stock_qty: 20 });

    const { data: orderId, error: saleError } = await client.rpc('submit_sale', {
      p_business_id: businessId,
      p_seller_id: userId,
      p_cart: [{ product_id: productId, variant_id: variantId, product_name: 'T-shirt', variant_name: 'Taille M', qty: 3, unit_price: 1000 }],
      p_total_amount: 3000,
      p_pay_method: 'especes',
      p_pay_amount: 3000,
    });
    expect(saleError).toBeNull();
    expect(await getProductStock(productId)).toBe(0); // parent untouched by the sale, as documented

    await client.rpc('cancel_sale', { p_sale_id: orderId, p_business_id: businessId, p_reason: 'Erreur' });

    expect(await getProductStock(productId)).toBe(0); // parent should still be 0 after cancellation
  });
});
