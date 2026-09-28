// Security audit 2026-09-27, checklist 1.14 (real enforcement, not UI
// hiding, per direct product decision) — a vendeur must never be able to
// read products.cost_price / product_variants.cost_price, through ANY path,
// not just the app's own default query. Exercises the real RLS policy
// change (migration_v193.sql) against a real Postgres instance, since RLS
// row-vs-column behavior can't be meaningfully asserted against a mock.
import {
  createTestUser, createTestBusiness, addMember, createTestProduct, createTestVariant,
} from './helpers';

describe('vendeur cost_price gate (real RLS, migration_v193)', () => {
  it("a vendeur's direct table query for products returns zero rows — not just fewer columns", async () => {
    const { client: adminC, userId: adminId } = await createTestUser('admin');
    const businessId = await createTestBusiness(adminC, 'Boutique Test');
    await createTestProduct(businessId, adminId, { cost_price: 50000, sale_price: 90000 });

    const { client: vendeurC, userId: vendeurId } = await createTestUser('vendeur');
    await addMember(businessId, vendeurId, 'vendeur');

    // The real attack this closes: a vendeur crafting their own REST call
    // against the raw table, bypassing the app's own query entirely.
    const { data, error } = await vendeurC.from('products').select('*').eq('business_id', businessId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("get_products_for_vendeur() returns real product data with cost_price always 0", async () => {
    const { client: adminC, userId: adminId } = await createTestUser('admin');
    const businessId = await createTestBusiness(adminC, 'Boutique Test');
    const productId = await createTestProduct(businessId, adminId, {
      name: 'Riz local', cost_price: 45000, sale_price: 60000, stock_qty: 20,
    });

    const { client: vendeurC, userId: vendeurId } = await createTestUser('vendeur');
    await addMember(businessId, vendeurId, 'vendeur');

    const { data, error } = await vendeurC.rpc('get_products_for_vendeur', { p_business_id: businessId });
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0].id).toBe(productId);
    expect(data![0].name).toBe('Riz local');
    expect(data![0].sale_price).toBe(60000); // real, legitimate to see
    expect(data![0].stock_qty).toBe(20);
    expect(data![0].cost_price).toBe(0); // never the real 45000
  });

  it('a non-member cannot call get_products_for_vendeur to read another business\'s catalog', async () => {
    const { client: adminC, userId: adminId } = await createTestUser('admin');
    const businessId = await createTestBusiness(adminC, 'Boutique Victime');
    await createTestProduct(businessId, adminId, { cost_price: 10000 });

    const { client: outsiderC } = await createTestUser('outsider');
    const { data, error } = await outsiderC.rpc('get_products_for_vendeur', { p_business_id: businessId });
    expect(error).toBeTruthy();
    expect(error!.message).toMatch(/Accès refusé/);
    expect(data).toBeFalsy();
  });

  it('variants: vendeur gets zero rows direct, real data with cost_price 0 via the RPC', async () => {
    const { client: adminC, userId: adminId } = await createTestUser('admin');
    const businessId = await createTestBusiness(adminC, 'Boutique Test');
    const productId = await createTestProduct(businessId, adminId);
    // createTestVariant already flips the parent's has_variants to true.
    const variantId = await createTestVariant(productId, businessId, {
      name: 'Taille L', cost_price: 8000, sale_price: 15000, stock_qty: 5,
    });

    const { client: vendeurC, userId: vendeurId } = await createTestUser('vendeur');
    await addMember(businessId, vendeurId, 'vendeur');

    const direct = await vendeurC.from('product_variants').select('*').eq('product_id', productId);
    expect(direct.error).toBeNull();
    expect(direct.data).toHaveLength(0);

    const viaRpc = await vendeurC.rpc('get_variants_for_vendeur', { p_product_id: productId, p_business_id: businessId });
    expect(viaRpc.error).toBeNull();
    expect(viaRpc.data).toHaveLength(1);
    expect(viaRpc.data![0].id).toBe(variantId);
    expect(viaRpc.data![0].sale_price).toBe(15000);
    expect(viaRpc.data![0].cost_price).toBe(0);
  });

  it('admin/manager access to cost_price is completely unaffected', async () => {
    const { client: adminC, userId: adminId } = await createTestUser('admin');
    const businessId = await createTestBusiness(adminC, 'Boutique Test');
    await createTestProduct(businessId, adminId, { cost_price: 45000 });

    const { data, error } = await adminC.from('products').select('*').eq('business_id', businessId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0].cost_price).toBe(45000);
  });
});
