// Prix convenu (v246) — the catalogue price of the moment is persisted,
// and reconciliation check #9 tolerates per-line rounding.
// Real Postgres via the local Supabase instance (scripts/test-db-setup.js).
import {
  createTestUser, createTestBusiness, createTestProduct, adminClient,
} from './helpers';

describe('submit_sale — catalog_unit_price (v246)', () => {
  it('stores the catalogue price sent with each line; absent field stays NULL', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Convenu');
    const riz = await createTestProduct(businessId, userId, { stock_qty: 10, sale_price: 450000, cost_price: 300000 });
    const huile = await createTestProduct(businessId, userId, { stock_qty: 10, sale_price: 300000, cost_price: 200000 });

    const { data: orderId, error } = await client.rpc('submit_sale', {
      p_business_id: businessId,
      p_seller_id: userId,
      p_cart: [
        // Agreed line: charged 400000, catalogue was 450000.
        { product_id: riz, product_name: 'Riz 5kg', qty: 1, unit_price: 400000, catalog_unit_price: 450000 },
        // A line whose writer sent no catalogue price (older client / other path).
        { product_id: huile, product_name: 'Huile', qty: 1, unit_price: 300000 },
      ],
      p_total_amount: 700000,
      p_pay_method: 'especes',
      p_pay_amount: 700000,
    });
    expect(error).toBeNull();

    const { data: lines } = await client
      .from('so_lines')
      .select('product_name, unit_price, catalog_unit_price')
      .eq('order_id', orderId as string)
      .order('product_name');
    expect(lines).toHaveLength(2);
    const rizLine = lines!.find(l => l.product_name === 'Riz 5kg')!;
    expect(Number(rizLine.unit_price)).toBe(400000);
    expect(Number(rizLine.catalog_unit_price)).toBe(450000);
    const huileLine = lines!.find(l => l.product_name === 'Huile')!;
    expect(huileLine.catalog_unit_price).toBeNull();
  });
});

describe('run_reconciliation — check #9 tolerance (v246)', () => {
  it('a 1-cent drift raises no finding; a 500-cent drift still does', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Recon');
    const productId = await createTestProduct(businessId, userId, { stock_qty: 50, sale_price: 1000, cost_price: 500 });
    const admin = adminClient();

    const mkSale = async (): Promise<string> => {
      const { data, error } = await client.rpc('submit_sale', {
        p_business_id: businessId,
        p_seller_id: userId,
        p_cart: [{ product_id: productId, product_name: 'Produit', qty: 2, unit_price: 1000 }],
        p_total_amount: 2000,
        p_pay_method: 'especes',
        p_pay_amount: 2000,
      });
      expect(error).toBeNull();
      return data as string;
    };

    const driftedSmall = await mkSale();
    const driftedBig = await mkSale();
    // Simulate the priceRatio rounding drift: stored total vs sum of lines.
    await admin.from('sale_orders').update({ total_amount: 2001 }).eq('id', driftedSmall);
    await admin.from('sale_orders').update({ total_amount: 2500 }).eq('id', driftedBig);

    const { data: runId, error: runErr } = await admin.rpc('run_reconciliation');
    expect(runErr).toBeNull();

    const { data: findings } = await admin
      .from('reconciliation_findings')
      .select('entity_id')
      .eq('run_id', runId as string)
      .eq('check_id', 9)
      .eq('business_id', businessId);
    const flagged = (findings ?? []).map(f => f.entity_id as string);
    expect(flagged).not.toContain(driftedSmall);
    expect(flagged).toContain(driftedBig);
  }, 30000); // run_reconciliation scans every business in the local DB
});
