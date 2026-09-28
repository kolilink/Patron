// Security audit 2026-09-27 — continuation of the SECURITY DEFINER sweep
// started in cross-business-po-flow.integration.test.ts. This file covers
// cancel_sale, create_product_with_stock (both fixed by migration_v188),
// and the money-moving RPCs that were read and assessed as already safe —
// each still gets a live cross-business test here rather than resting on
// that reading, per the standing rule this sweep itself is adding to
// CLAUDE.md: a definer function that takes an object id ships with a real
// cross-business test proving the lookup is scoped, not just a reasoned
// argument that it must be.
import { randomUUID } from 'crypto';
import {
  createTestUser, createTestBusiness, createTestProduct, createTestVariant,
  addMember, adminClient,
} from './helpers';

describe('cancel_sale — cross-business stock restore', () => {
  it("does not restore stock onto another business's product/variant even via a directly-inserted so_lines row (fixed — defense in depth)", async () => {
    const { client: victimC, userId: victimUserId } = await createTestUser('victim');
    const victimBusinessId = await createTestBusiness(victimC, 'Boutique Victime');
    const victimProductId = await createTestProduct(victimBusinessId, victimUserId, { stock_qty: 30 });

    const { client: attackerC, userId: attackerUserId } = await createTestUser('attacker');
    const attackerBusinessId = await createTestBusiness(attackerC, 'Boutique Attaquant');

    const admin = adminClient();
    const { data: order } = await admin.from('sale_orders').insert({
      business_id: attackerBusinessId, seller_id: attackerUserId, status: 'paye',
      total_amount: 1000, is_credit: false, created_by: attackerUserId,
    }).select('id').single();
    await admin.from('so_lines').insert({
      order_id: order!.id, product_id: victimProductId, product_name: 'x', qty: 5, unit_price: 1000,
    });

    const { error } = await attackerC.rpc('cancel_sale', {
      p_sale_id: order!.id, p_business_id: attackerBusinessId, p_reason: 'test',
    });
    expect(error).toBeNull(); // cancellation itself always succeeds — stock restore is best-effort

    const { data: victimProduct } = await admin.from('products').select('stock_qty').eq('id', victimProductId).single();
    expect(victimProduct!.stock_qty).toBe(30); // untouched, not 35
  });

  it('still restores stock normally for a real sale in the caller\'s own business (no regression)', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const productId = await createTestProduct(businessId, userId, { stock_qty: 20, sale_price: 1000, cost_price: 500 });

    const { data: saleId } = await client.rpc('submit_sale', {
      p_business_id: businessId,
      p_seller_id: userId,
      p_cart: [{ product_id: productId, product_name: 'x', qty: 5, unit_price: 1000 }],
      p_total_amount: 5000,
    });

    const admin = adminClient();
    const { data: afterSale } = await admin.from('products').select('stock_qty').eq('id', productId).single();
    expect(afterSale!.stock_qty).toBe(15);

    const { error } = await client.rpc('cancel_sale', { p_sale_id: saleId, p_business_id: businessId, p_reason: 'test' });
    expect(error).toBeNull();

    const { data: afterCancel } = await admin.from('products').select('stock_qty').eq('id', productId).single();
    expect(afterCancel!.stock_qty).toBe(20);
  });
});

describe('create_product_with_stock — cross-business stock_move forgery', () => {
  it("forces the stock_move's business_id and created_by to the validated caller/business, ignoring a spoofed payload (fixed)", async () => {
    const { client: attackerC, userId: attackerUserId } = await createTestUser('attacker');
    const attackerBusinessId = await createTestBusiness(attackerC, 'Boutique Attaquant');

    const { client: victimC, userId: victimUserId } = await createTestUser('victim');
    const victimBusinessId = await createTestBusiness(victimC, 'Boutique Victime');

    const productId = randomUUID();
    const moveId = randomUUID();

    const { error } = await attackerC.rpc('create_product_with_stock', {
      p_product: {
        id: productId, business_id: attackerBusinessId, name: 'Produit', unit: 'unite',
        cost_price: 100, sale_price: 200, reorder_level: 0, stock_qty: 10, archived: false,
        created_by: attackerUserId,
      },
      p_stock_move: {
        id: moveId,
        business_id: victimBusinessId, // spoofed — attacker's own business is attackerBusinessId
        type: 'entree', qty: 10, ref_type: 'creation',
        created_by: victimUserId, // spoofed — impersonating the victim
      },
    });
    expect(error).toBeNull();

    const admin = adminClient();
    const { data: move } = await admin.from('stock_moves').select('business_id, created_by').eq('id', moveId).single();
    expect(move!.business_id).toBe(attackerBusinessId); // forced, not the spoofed victimBusinessId
    expect(move!.created_by).toBe(attackerUserId); // forced, not the spoofed victimUserId
  });
});

describe('edit_sale — cross-business line/payment references (confirmed safe)', () => {
  it("cannot edit a line or payment belonging to another business's sale", async () => {
    const { client: victimC, userId: victimUserId } = await createTestUser('victim');
    const victimBusinessId = await createTestBusiness(victimC, 'Boutique Victime');
    const victimProductId = await createTestProduct(victimBusinessId, victimUserId, { sale_price: 1000, cost_price: 500 });

    const { data: victimSaleId } = await victimC.rpc('submit_sale', {
      p_business_id: victimBusinessId,
      p_seller_id: victimUserId,
      p_cart: [{ product_id: victimProductId, product_name: 'x', qty: 1, unit_price: 1000 }],
      p_total_amount: 1000,
    });

    const { client: attackerC } = await createTestUser('attacker');
    const attackerBusinessId = await createTestBusiness(attackerC, 'Boutique Attaquant');

    const { error } = await attackerC.rpc('edit_sale', {
      p_sale_id: victimSaleId, p_business_id: attackerBusinessId, p_discount_amount: 0,
    });
    expect(error).toBeTruthy();

    const admin = adminClient();
    const { data: victimSale } = await admin.from('sale_orders').select('total_amount').eq('id', victimSaleId).single();
    expect(victimSale!.total_amount).toBe(1000); // untouched
  });
});

describe('record_client_payment — cross-business customer_name matching (confirmed safe)', () => {
  it("does not pay off another business's credit sale for a same-named customer", async () => {
    const { client: victimC, userId: victimUserId } = await createTestUser('victim');
    const victimBusinessId = await createTestBusiness(victimC, 'Boutique Victime');
    const victimProductId = await createTestProduct(victimBusinessId, victimUserId, { sale_price: 5000, cost_price: 1000 });

    await victimC.rpc('submit_carnet_debt', {
      p_business_id: victimBusinessId, p_seller_id: victimUserId,
      p_customer_name: 'Mamadou', p_amount: 5000,
    });

    const { client: attackerC, userId: attackerUserId } = await createTestUser('attacker');
    const attackerBusinessId = await createTestBusiness(attackerC, 'Boutique Attaquant');

    // Attacker pays off "Mamadou" in their OWN (unrelated) business — should
    // simply find nothing to allocate against, not touch the victim's sale.
    const { data, error } = await attackerC.rpc('record_client_payment', {
      p_business_id: attackerBusinessId, p_customer_name: 'Mamadou',
      p_amount: 5000, p_method: 'especes', p_date: new Date().toISOString().slice(0, 10),
    });
    expect(error).toBeNull();
    expect(data.fully_settled).toBe(true); // vacuously true — no credit sales at all in attacker's business

    const admin = adminClient();
    const { data: victimSales } = await admin.from('sale_orders').select('status').eq('business_id', victimBusinessId).eq('customer_name', 'Mamadou');
    expect(victimSales![0].status).toBe('credit'); // still unpaid, untouched by the attacker's call
  });
});

describe('pay_supplier_debt — cross-business supplier_id matching (confirmed safe)', () => {
  it("does not pay off another business's supplier debt", async () => {
    const { client: victimC, userId: victimUserId } = await createTestUser('victim');
    const victimBusinessId = await createTestBusiness(victimC, 'Boutique Victime');
    const admin = adminClient();
    const { data: supplier } = await admin.from('suppliers').insert({ business_id: victimBusinessId, name: 'Fournisseur', created_by: victimUserId }).select('id').single();
    await admin.from('supplier_debts').insert({
      business_id: victimBusinessId, supplier_id: supplier!.id, amount: 10000, amount_paid: 0,
      date: new Date().toISOString().slice(0, 10), created_by: victimUserId,
    });

    const { client: attackerC } = await createTestUser('attacker');
    const attackerBusinessId = await createTestBusiness(attackerC, 'Boutique Attaquant');

    const { data, error } = await attackerC.rpc('pay_supplier_debt', {
      p_business_id: attackerBusinessId, p_supplier_id: supplier!.id, p_amount_cents: 10000,
    });
    expect(error).toBeNull();
    expect(data.remaining_cents).toBe(10000); // nothing allocated — supplier belongs to a different business

    const { data: debt } = await admin.from('supplier_debts').select('amount_paid').eq('supplier_id', supplier!.id).single();
    expect(debt!.amount_paid).toBe(0); // untouched
  });
});

describe('confirm_payout / request_payout — cross-business payout id (confirmed safe)', () => {
  it("an admin of a different business cannot confirm another business's payout request", async () => {
    const { client: victimAdminC, userId: victimAdminId } = await createTestUser('victimadmin');
    const victimBusinessId = await createTestBusiness(victimAdminC, 'Boutique Victime');
    const { client: investorC, userId: investorId } = await createTestUser('investor');
    await addMember(victimBusinessId, investorId, 'investisseur');

    const admin = adminClient();
    await admin.from('investor_balance').insert({ business_id: victimBusinessId, investor_id: investorId, balance: 10000 });
    const { data: payoutId, error: reqErr } = await investorC.rpc('request_payout', { p_business_id: victimBusinessId, p_amount: 5000 });
    expect(reqErr).toBeNull();

    const { client: attackerC } = await createTestUser('attacker');
    await createTestBusiness(attackerC, 'Boutique Attaquant'); // attacker is admin of their own, unrelated business

    const { error } = await attackerC.rpc('confirm_payout', { p_payout_id: payoutId, p_paid_amount: 5000 });
    expect(error).toBeTruthy();

    const { data: payout } = await admin.from('investor_payouts').select('status').eq('id', payoutId).single();
    expect(payout!.status).toBe('en_attente'); // untouched
  });
});

describe('edit_injection — cross-business injection id (confirmed safe)', () => {
  it("an admin of a different business cannot edit another business's capital injection", async () => {
    const { client: victimC, userId: victimUserId } = await createTestUser('victim');
    const victimBusinessId = await createTestBusiness(victimC, 'Boutique Victime');
    const { data: injectionId, error: recErr } = await victimC.rpc('record_injection', {
      p_business_id: victimBusinessId, p_amount: 100000,
    });
    expect(recErr).toBeNull();

    const { client: attackerC } = await createTestUser('attacker');
    await createTestBusiness(attackerC, 'Boutique Attaquant');

    const { error } = await attackerC.rpc('edit_injection', { p_id: injectionId, p_amount: 999999 });
    expect(error).toBeTruthy();

    const admin = adminClient();
    const { data: injection } = await admin.from('capital_injections').select('amount').eq('id', injectionId).single();
    expect(injection!.amount).toBe(100000); // untouched
  });
});

describe('upsert_product_variants — cross-business product_id (fixed)', () => {
  it("rejects a foreign product_id outright and creates nothing on the victim's product", async () => {
    const { client: victimC, userId: victimUserId } = await createTestUser('victim');
    const victimBusinessId = await createTestBusiness(victimC, 'Boutique Victime');
    const victimProductId = await createTestProduct(victimBusinessId, victimUserId);

    const { client: attackerC } = await createTestUser('attacker');
    const attackerBusinessId = await createTestBusiness(attackerC, 'Boutique Attaquant');

    const { error } = await attackerC.rpc('upsert_product_variants', {
      p_business_id: attackerBusinessId, p_product_id: victimProductId,
      p_variants: [{ name: 'Taille M', sale_price: 1000, cost_price: 500, stock_qty: 10, reorder_level: 0 }],
    });
    // Previously this silently created a variant row cross-referencing the
    // attacker's business_id with the victim's product_id — see
    // migration_v188.sql's fix #6 (found live, not by reading).
    expect(error).toBeTruthy();

    const admin = adminClient();
    const { data: victimVariants } = await admin.from('product_variants').select('id').eq('product_id', victimProductId);
    expect(victimVariants).toHaveLength(0); // nothing created on the victim's product
    const { data: victimProduct } = await admin.from('products').select('has_variants').eq('id', victimProductId).single();
    expect(victimProduct!.has_variants).toBe(false); // untouched
  });

  it('still works normally for a real product in the caller\'s own business (no regression)', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const productId = await createTestProduct(businessId, userId);

    const { error } = await client.rpc('upsert_product_variants', {
      p_business_id: businessId, p_product_id: productId,
      p_variants: [{ name: 'Taille M', sale_price: 1000, cost_price: 500, stock_qty: 10, reorder_level: 0 }],
    });
    expect(error).toBeNull();

    const admin = adminClient();
    const { data: variants } = await admin.from('product_variants').select('id').eq('product_id', productId);
    expect(variants).toHaveLength(1);
  });
});
