// Exercises the real edit_sale() Postgres function (migration_v151.sql)
// against a local Supabase instance — role/window/count gating, the
// server-derived total_amount, the credit-vs-paye payment guard, the
// investor_balance profit-share delta, and the sale_order_edits audit
// snapshot. Unlike __tests__/*.test.ts (which mock supabase.rpc entirely),
// this is what actually proves the SQL behaves the way the design assumed.
import { randomUUID } from 'crypto';
import {
  createTestUser, createTestBusiness, addMember, createTestProduct, adminClient,
} from './helpers';

async function submitSale(
  client: any, businessId: string, userId: string, productId: string,
  qty: number, unitPrice: number, opts: { isCredit?: boolean; payAmount?: number } = {},
) {
  const total = qty * unitPrice;
  const { data: orderId, error } = await client.rpc('submit_sale', {
    p_business_id: businessId,
    p_seller_id: userId,
    p_cart: [{ product_id: productId, product_name: 'Produit test', qty, unit_price: unitPrice }],
    p_total_amount: total,
    p_is_credit: opts.isCredit ?? false,
    p_pay_method: opts.isCredit ? (opts.payAmount ? 'especes' : undefined) : 'especes',
    p_pay_amount: opts.isCredit ? opts.payAmount : total,
  });
  if (error) throw error;
  return orderId as string;
}

async function getLineId(orderId: string): Promise<string> {
  const admin = adminClient();
  const { data, error } = await admin.from('so_lines').select('id').eq('order_id', orderId).single();
  if (error) throw error;
  return data.id;
}

async function getPaymentId(orderId: string): Promise<string> {
  const admin = adminClient();
  const { data, error } = await admin.from('payments').select('id').eq('order_id', orderId).single();
  if (error) throw error;
  return data.id;
}

async function backdateSale(orderId: string, hoursAgo: number): Promise<void> {
  const admin = adminClient();
  const { error } = await admin
    .from('sale_orders')
    .update({ created_at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString() })
    .eq('id', orderId);
  if (error) throw error;
}

describe('edit_sale (real RPC)', () => {
  it('corrects a line price + payment together, recomputes total server-side, stamps edit_count/last_edited_by', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const productId = await createTestProduct(businessId, userId, { cost_price: 500 });
    const orderId = await submitSale(client, businessId, userId, productId, 3, 1000); // total 3000

    const lineId = await getLineId(orderId);
    const paymentId = await getPaymentId(orderId);

    const { data, error } = await client.rpc('edit_sale', {
      p_sale_id: orderId,
      p_business_id: businessId,
      p_discount_amount: 0,
      p_line_edits: [{ line_id: lineId, unit_price: 1200 }], // corrected price
      p_payment_edits: [{ payment_id: paymentId, method: 'especes', amount: 3600, ref_external: null }],
      p_reason: 'Prix mal saisi',
    });

    expect(error).toBeNull();
    expect(data.total_amount).toBe(3600); // server-derived from so_lines, not client-supplied
    expect(data.edit_count).toBe(1);
    expect(data.last_edited_by).toBe(userId);

    const { data: line } = await client.from('so_lines').select('unit_price').eq('id', lineId).single();
    expect(line!.unit_price).toBe(1200);

    const { data: edits } = await client.from('sale_order_edits').select('*').eq('order_id', orderId);
    expect(edits).toHaveLength(1);
    expect(edits![0].edit_number).toBe(1);
    expect(edits![0].before.total_amount).toBe(3000);
    expect(edits![0].after.total_amount).toBe(3600);
  });

  it('rejects a credit-sale edit that would leave payments exceeding the new owed amount', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const productId = await createTestProduct(businessId, userId);
    // Credit sale: 3000 owed, 1000 collected so far.
    const orderId = await submitSale(client, businessId, userId, productId, 3, 1000, { isCredit: true, payAmount: 1000 });
    const lineId = await getLineId(orderId);

    // Dropping the price to 200/unit makes owed = 600, less than the 1000 already collected.
    const { error } = await client.rpc('edit_sale', {
      p_sale_id: orderId,
      p_business_id: businessId,
      p_discount_amount: 0,
      p_line_edits: [{ line_id: lineId, unit_price: 200 }],
      p_payment_edits: [],
    });

    expect(error).toBeTruthy();
    expect(error!.message).toMatch(/dépasserait/);
  });

  it('rejects a paye-sale edit that leaves payments out of sync, succeeds once the payment is adjusted too', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const productId = await createTestProduct(businessId, userId);
    const orderId = await submitSale(client, businessId, userId, productId, 2, 1000); // paye, total 2000
    const paymentId = await getPaymentId(orderId);

    const rejected = await client.rpc('edit_sale', {
      p_sale_id: orderId,
      p_business_id: businessId,
      p_discount_amount: 500, // owed drops to 1500, payment still 2000
      p_line_edits: [],
      p_payment_edits: [],
    });
    expect(rejected.error).toBeTruthy();
    expect(rejected.error!.message).toMatch(/doit correspondre/);

    const accepted = await client.rpc('edit_sale', {
      p_sale_id: orderId,
      p_business_id: businessId,
      p_discount_amount: 500,
      p_line_edits: [],
      p_payment_edits: [{ payment_id: paymentId, method: 'especes', amount: 1500, ref_external: null }],
    });
    expect(accepted.error).toBeNull();
    expect(accepted.data.discount_amount).toBe(500);
  });

  it('rejects a discount that would be >= the total', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const productId = await createTestProduct(businessId, userId);
    const orderId = await submitSale(client, businessId, userId, productId, 2, 1000); // total 2000

    const { error } = await client.rpc('edit_sale', {
      p_sale_id: orderId,
      p_business_id: businessId,
      p_discount_amount: 2000,
      p_line_edits: [],
      p_payment_edits: [],
    });
    expect(error).toBeTruthy();
    expect(error!.message).toMatch(/inférieure au total/);
  });

  it('enforces the max-edit-count cap from app_config (2 edits allowed, 3rd rejected)', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const productId = await createTestProduct(businessId, userId);
    const orderId = await submitSale(client, businessId, userId, productId, 1, 1000);

    const editOnce = () => client.rpc('edit_sale', {
      p_sale_id: orderId, p_business_id: businessId,
      p_customer_name: `Client ${randomUUID().slice(0, 4)}`,
      p_discount_amount: 0, p_line_edits: [], p_payment_edits: [],
    });

    const first = await editOnce();
    expect(first.error).toBeNull();
    const second = await editOnce();
    expect(second.error).toBeNull();
    const third = await editOnce();
    expect(third.error).toBeTruthy();
    expect(third.error!.message).toMatch(/maximum de modifications/);
  });

  it('enforces the 48h edit window from app_config', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const productId = await createTestProduct(businessId, userId);
    const orderId = await submitSale(client, businessId, userId, productId, 1, 1000);
    await backdateSale(orderId, 49); // just past the 48h window

    const { error } = await client.rpc('edit_sale', {
      p_sale_id: orderId, p_business_id: businessId,
      p_discount_amount: 0, p_line_edits: [], p_payment_edits: [],
    });
    expect(error).toBeTruthy();
    expect(error!.message).toMatch(/délai de modification/);
  });

  it('rejects a vendeur outright — edit_sale is admin/manager only', async () => {
    const { client: adminC, userId: adminId } = await createTestUser('admin');
    const businessId = await createTestBusiness(adminC, 'Boutique Test');
    const productId = await createTestProduct(businessId, adminId);

    const { client: vendeurC, userId: vendeurId } = await createTestUser('vendeur');
    await addMember(businessId, vendeurId, 'vendeur');
    const orderId = await submitSale(vendeurC, businessId, vendeurId, productId, 1, 1000);

    const { error } = await vendeurC.rpc('edit_sale', {
      p_sale_id: orderId, p_business_id: businessId,
      p_discount_amount: 0, p_line_edits: [], p_payment_edits: [],
    });
    expect(error).toBeTruthy();
    expect(error!.message).toMatch(/Accès refusé/);
  });

  it('allows a manager to edit a sale made by a different vendeur', async () => {
    const { client: adminC, userId: adminId } = await createTestUser('admin');
    const businessId = await createTestBusiness(adminC, 'Boutique Test');
    const productId = await createTestProduct(businessId, adminId);

    const { client: vendeurC, userId: vendeurId } = await createTestUser('vendeur');
    await addMember(businessId, vendeurId, 'vendeur');
    const orderId = await submitSale(vendeurC, businessId, vendeurId, productId, 1, 1000);

    const { client: managerC, userId: managerId } = await createTestUser('manager');
    await addMember(businessId, managerId, 'manager');

    const { data, error } = await managerC.rpc('edit_sale', {
      p_sale_id: orderId, p_business_id: businessId,
      p_customer_name: 'Corrigé par manager',
      p_discount_amount: 0, p_line_edits: [], p_payment_edits: [],
    });
    expect(error).toBeNull();
    expect(data.last_edited_by).toBe(managerId);
    expect(data.customer_name).toBe('Corrigé par manager');
  });

  it('applies the investor profit-share delta when a line price is corrected', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const productId = await createTestProduct(businessId, userId, { cost_price: 500 });

    const { client: investorC, userId: investorId } = await createTestUser('investisseur');
    await addMember(businessId, investorId, 'investisseur');

    const admin = adminClient();
    const { data: membership } = await admin
      .from('memberships').select('id').eq('business_id', businessId).eq('user_id', investorId).single();
    await admin.from('membership_product_scope').insert({
      membership_id: membership!.id, product_id: productId, profit_share: 50,
    });

    // Sold at 1000 (cost 500) → profit 500/unit × 2 = 1000 total → investor gets 50% = 500.
    const orderId = await submitSale(client, businessId, userId, productId, 2, 1000);
    const { data: balanceAfterSale } = await admin
      .from('investor_balance').select('balance').eq('business_id', businessId).eq('investor_id', investorId).single();
    expect(balanceAfterSale!.balance).toBe(500);

    // Correct the price up to 1500 (profit 1000/unit × 2 = 2000 total) → investor should gain
    // the delta (50% of the +1000 profit increase = +500), landing at 1000, not desync silently.
    const lineId = await getLineId(orderId);
    const paymentId = await getPaymentId(orderId);
    const { error } = await client.rpc('edit_sale', {
      p_sale_id: orderId, p_business_id: businessId,
      p_discount_amount: 0,
      p_line_edits: [{ line_id: lineId, unit_price: 1500 }],
      p_payment_edits: [{ payment_id: paymentId, method: 'especes', amount: 3000, ref_external: null }],
    });
    expect(error).toBeNull();

    const { data: balanceAfterEdit } = await admin
      .from('investor_balance').select('balance').eq('business_id', businessId).eq('investor_id', investorId).single();
    expect(balanceAfterEdit!.balance).toBe(1000);
  });

  it('rejects editing a cancelled sale', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const productId = await createTestProduct(businessId, userId);
    const orderId = await submitSale(client, businessId, userId, productId, 1, 1000);
    await client.rpc('cancel_sale', { p_sale_id: orderId, p_business_id: businessId, p_reason: 'Erreur' });

    const { error } = await client.rpc('edit_sale', {
      p_sale_id: orderId, p_business_id: businessId,
      p_discount_amount: 0, p_line_edits: [], p_payment_edits: [],
    });
    expect(error).toBeTruthy();
    expect(error!.message).toMatch(/payées ou à crédit/);
  });
});
