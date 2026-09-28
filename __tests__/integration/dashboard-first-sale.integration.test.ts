// Exercises get_dashboard_kpis()'s first_sale_at field (migration_v199)
// against a live Postgres instance — backs Accueil's one-time "Première
// vente notée ✓" acknowledgment. The rule under test: a real (status='paye')
// sale counts, a credit debt never does, and the value is business-wide
// (visible to a vendeur even for a sale they didn't personally make),
// exactly the shape a mocked-Supabase unit test can't meaningfully verify.
import { createTestUser, createTestBusiness, addMember, adminClient } from './helpers';
import { randomUUID } from 'crypto';

async function getKpis(client: ReturnType<typeof adminClient>, businessId: string) {
  const { data, error } = await client.rpc('get_dashboard_kpis', { p_business_id: businessId });
  expect(error).toBeNull();
  return data as { first_sale_at: string | null };
}

describe('get_dashboard_kpis — first_sale_at', () => {
  it('is null for a business with no sales at all', async () => {
    const { client } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');

    const kpis = await getKpis(client, businessId);
    expect(kpis.first_sale_at).toBeNull();
  });

  it('stays null after a credit debt with no real sale yet', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');

    const { error } = await client.rpc('submit_carnet_debt', {
      p_business_id: businessId, p_seller_id: userId, p_customer_name: 'Fatoumata', p_amount: 500000,
    });
    expect(error).toBeNull();

    const kpis = await getKpis(client, businessId);
    expect(kpis.first_sale_at).toBeNull();
  });

  it('is set the moment a real quick sale (status=paye) is recorded', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');

    const before = Date.now();
    const { error } = await client.rpc('submit_quick_sale', {
      p_business_id: businessId, p_seller_id: userId, p_unit_price: 200000,
    });
    expect(error).toBeNull();

    const kpis = await getKpis(client, businessId);
    expect(kpis.first_sale_at).not.toBeNull();
    expect(new Date(kpis.first_sale_at as string).getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it('keeps the earliest sale even after later ones — a MIN, not the latest', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const admin = adminClient();

    const { data: firstId } = await client.rpc('submit_quick_sale', {
      p_business_id: businessId, p_seller_id: userId, p_unit_price: 100000,
    });
    const firstKpis = await getKpis(client, businessId);
    const firstSaleAt = firstKpis.first_sale_at;
    expect(firstSaleAt).not.toBeNull();

    // A second, later sale must not move first_sale_at forward.
    await client.rpc('submit_quick_sale', { p_business_id: businessId, p_seller_id: userId, p_unit_price: 300000 });
    const secondKpis = await getKpis(client, businessId);
    expect(secondKpis.first_sale_at).toBe(firstSaleAt);

    // Sanity: two distinct real sale_orders rows exist.
    const { data: sales } = await admin.from('sale_orders').select('id').eq('business_id', businessId).eq('status', 'paye');
    expect(sales).toHaveLength(2);
    expect((sales ?? []).some(s => s.id === firstId)).toBe(true);
  });

  it('is business-wide, not seller-scoped — a vendeur sees a sale made by the admin', async () => {
    const { client: adminC, userId: adminId } = await createTestUser('admin');
    const businessId = await createTestBusiness(adminC, 'Boutique Test');
    const { client: vendeurC, userId: vendeurId } = await createTestUser('vendeur');
    await addMember(businessId, vendeurId, 'vendeur');

    const { error } = await adminC.rpc('submit_quick_sale', {
      p_business_id: businessId, p_seller_id: adminId, p_unit_price: 400000,
    });
    expect(error).toBeNull();

    const kpisAsVendeur = await getKpis(vendeurC, businessId);
    expect(kpisAsVendeur.first_sale_at).not.toBeNull();
  });

  it('a real sale still counts even if a credit debt was recorded first', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');

    await client.rpc('submit_carnet_debt', {
      p_business_id: businessId, p_seller_id: userId, p_customer_name: 'Test', p_amount: 100000,
    });
    const afterDebt = await getKpis(client, businessId);
    expect(afterDebt.first_sale_at).toBeNull();

    await client.rpc('submit_quick_sale', { p_business_id: businessId, p_seller_id: userId, p_unit_price: 100000 });
    const afterSale = await getKpis(client, businessId);
    expect(afterSale.first_sale_at).not.toBeNull();
  });
});
