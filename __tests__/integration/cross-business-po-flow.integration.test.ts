// Security audit 2026-09-27 — systematic sweep of every SECURITY DEFINER
// function that takes an object id and touches stock or money, prompted by
// the two real bugs found in submit_sale (migration_v195). Same method:
// predict, test live against the current (possibly unfixed) function,
// confirm, then fix. This file covers the purchase-order flow, where the
// worst findings turned out to be.
import {
  createTestUser, createTestBusiness, createTestProduct, createTestVariant, getProductStock,
} from './helpers';

describe('confirm_reception — cross-business product references', () => {
  it("cannot overwrite another business's product sale_price via an existing product_id (fixed — was a direct, unchained bug)", async () => {
    const { client: victimC, userId: victimUserId } = await createTestUser('victim');
    const victimBusinessId = await createTestBusiness(victimC, 'Boutique Victime');
    const victimProductId = await createTestProduct(victimBusinessId, victimUserId, { sale_price: 1000 });

    const { client: attackerC, userId: attackerUserId } = await createTestUser('attacker');
    const attackerBusinessId = await createTestBusiness(attackerC, 'Boutique Attaquant');

    const { error } = await attackerC.rpc('confirm_reception', {
      p_business_id: attackerBusinessId,
      p_lines: [{ product_id: victimProductId, qty: 1, unit_cost_cents: 100, sale_price_cents: 999999 }],
    });

    expect(error).toBeTruthy();
    const { data: victimProduct } = await victimC.from('products').select('sale_price').eq('id', victimProductId).single();
    expect(victimProduct!.sale_price).toBe(1000); // untouched, not 999999
  });

  it("cannot create a po_lines row referencing another business's product (fixed)", async () => {
    const { client: victimC, userId: victimUserId } = await createTestUser('victim2');
    const victimBusinessId = await createTestBusiness(victimC, 'Boutique Victime 2');
    const victimProductId = await createTestProduct(victimBusinessId, victimUserId);

    const { client: attackerC } = await createTestUser('attacker2');
    const attackerBusinessId = await createTestBusiness(attackerC, 'Boutique Attaquant 2');

    const { error } = await attackerC.rpc('confirm_reception', {
      p_business_id: attackerBusinessId,
      p_lines: [{ product_id: victimProductId, qty: 5, unit_cost_cents: 100 }],
    });

    expect(error).toBeTruthy();
  });

  it('still works normally for a real product in the caller\'s own business (no regression)', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const productId = await createTestProduct(businessId, userId, { stock_qty: 10, cost_price: 500 });

    const { data: poId, error } = await client.rpc('confirm_reception', {
      p_business_id: businessId,
      p_lines: [{ product_id: productId, qty: 5, unit_cost_cents: 60000, sale_price_cents: 100000 }],
    });

    expect(error).toBeNull();
    expect(poId).toBeTruthy();
    expect(await getProductStock(productId)).toBe(15); // 10 + 5 received
  });
});

describe('create_purchase_order — cross-business product references', () => {
  it("cannot create po_lines referencing another business's product or variant (fixed)", async () => {
    const { client: victimC, userId: victimUserId } = await createTestUser('victim3');
    const victimBusinessId = await createTestBusiness(victimC, 'Boutique Victime 3');
    const victimProductId = await createTestProduct(victimBusinessId, victimUserId);
    const { client: victimC2, userId: victimUserId2 } = await createTestUser('victim4');
    const victimBusinessId2 = await createTestBusiness(victimC2, 'Boutique Victime 4');
    const victimProductId2 = await createTestProduct(victimBusinessId2, victimUserId2);
    const victimVariantId = await createTestVariant(victimProductId2, victimBusinessId2);

    const { client: attackerC, userId: attackerUserId } = await createTestUser('attacker3');
    const attackerBusinessId = await createTestBusiness(attackerC, 'Boutique Attaquant 3');
    const { data: supplierId } = await attackerC.from('suppliers').insert({ business_id: attackerBusinessId, name: 'Test', created_by: attackerUserId }).select('id').single();

    const { error: err1 } = await attackerC.rpc('create_purchase_order', {
      p_business_id: attackerBusinessId,
      p_supplier_id: supplierId!.id,
      p_lines: [{ product_id: victimProductId, qty: 1, unit_cost: 100 }],
    });
    expect(err1).toBeTruthy();

    const { error: err2 } = await attackerC.rpc('create_purchase_order', {
      p_business_id: attackerBusinessId,
      p_supplier_id: supplierId!.id,
      p_lines: [{ product_id: victimProductId2, variant_id: victimVariantId, qty: 1, unit_cost: 100 }],
    });
    expect(err2).toBeTruthy();
  });

  it('still works normally for a real product in the caller\'s own business (no regression)', async () => {
    const { client, userId } = await createTestUser('admin2');
    const businessId = await createTestBusiness(client, 'Boutique Test 2');
    const productId = await createTestProduct(businessId, userId);
    const { data: supplierId } = await client.from('suppliers').insert({ business_id: businessId, name: 'Test', created_by: userId }).select('id').single();

    const { data: poId, error } = await client.rpc('create_purchase_order', {
      p_business_id: businessId,
      p_supplier_id: supplierId!.id,
      p_lines: [{ product_id: productId, qty: 3, unit_cost: 500 }],
      p_amount_paid: 0,
    });

    expect(error).toBeNull();
    expect(poId).toBeTruthy();
  });
});

describe('receive_purchase_order — cross-business variant stock/cost corruption', () => {
  it("does not update another business's product_variants row even if a po_lines row somehow references one (fixed — defense in depth)", async () => {
    const { client: victimC, userId: victimUserId } = await createTestUser('victim5');
    const victimBusinessId = await createTestBusiness(victimC, 'Boutique Victime 5');
    const victimProductId = await createTestProduct(victimBusinessId, victimUserId);
    const victimVariantId = await createTestVariant(victimProductId, victimBusinessId, { stock_qty: 20, cost_price: 1000 });

    const { client: attackerC, userId: attackerUserId } = await createTestUser('attacker4');
    const attackerBusinessId = await createTestBusiness(attackerC, 'Boutique Attaquant 4');

    // Bypass create_purchase_order/confirm_reception's own (now-fixed) guards
    // entirely — insert the malicious po_lines row directly via the service
    // key, to test receive_purchase_order's OWN defense in isolation, the
    // same way the migration's comment frames it: "a future edit that
    // weakens the upfront pass doesn't silently reopen this on its own."
    const admin = (await import('./helpers')).adminClient();
    const { data: supplier } = await admin.from('suppliers').insert({
      business_id: attackerBusinessId, name: 'Test', created_by: attackerUserId,
    }).select('id').single();
    const { data: po } = await admin.from('purchase_orders').insert({
      business_id: attackerBusinessId, supplier_id: supplier!.id, status: 'brouillon', created_by: attackerUserId,
    }).select('id').single();
    await admin.from('po_lines').insert({
      po_id: po!.id, product_id: victimProductId, variant_id: victimVariantId,
      qty_ordered: 5, qty_received: 0, unit_cost: 100,
    });

    // Explicit p_line_ids/p_line_qtys/p_shipping_cost_cents to avoid the
    // PostgREST overload-ambiguity error against the stale, unreachable
    // 2-arg receive_purchase_order(uuid, uuid) overload left over from
    // before confirm_reception existed (dropped for real by migration_v196,
    // this stays explicit as belt-and-suspenders).
    const { error: recvErr } = await attackerC.rpc('receive_purchase_order', {
      p_po_id: po!.id, p_business_id: attackerBusinessId,
      p_line_ids: null, p_line_qtys: null, p_shipping_cost_cents: 0,
    });
    expect(recvErr).toBeNull();

    const { data: variant } = await admin.from('product_variants').select('stock_qty, cost_price').eq('id', victimVariantId).single();
    expect(variant!.stock_qty).toBe(20); // untouched, not 25
    expect(variant!.cost_price).toBe(1000); // untouched
  });
});
