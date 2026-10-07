// migration_v243: the server side of the newly phone-first (queued) actions.
// Each replay must be idempotent — a lost response + retry must never double-apply
// — and, per the standing rule for every definer function taking an object id,
// must be proven scoped to the caller's own business with a live cross-business call.
import { createTestUser, createTestBusiness, createTestProduct, addMember, adminClient, getProductStock } from './helpers';
import { randomUUID } from 'crypto';

async function supplierWithDebt(client: Awaited<ReturnType<typeof createTestUser>>['client'], businessId: string, userId: string, amountCents: number) {
  const { data: supplier, error } = await client.from('suppliers').insert({ business_id: businessId, name: 'Fourn', created_by: userId }).select('id').single();
  expect(error).toBeNull();
  const supplierId = (supplier as { id: string }).id;
  const debtId = randomUUID();
  const { error: dErr } = await client.from('supplier_debts').insert({ id: debtId, business_id: businessId, supplier_id: supplierId, amount: amountCents, amount_paid: 0, date: '2026-10-01', created_by: userId });
  expect(dErr).toBeNull();
  return { supplierId, debtId };
}

describe('create_product_with_stock is idempotent (v243)', () => {
  const row = (businessId: string, userId: string, id: string) => ({
    id, business_id: businessId, name: 'Riz', sku: null, category: null, unit: 'sac', cost_price: 1000, sale_price: 1500,
    reorder_level: 0, stock_qty: 5, archived: false, supplier_id: null, purchase_date: null, bulk_price: null, bulk_min_qty: null, created_by: userId,
  });

  it('a replay of the same product id (and stock move id) returns success and creates nothing twice', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'B1');
    const id = randomUUID();
    const move = { id: randomUUID(), type: 'entree', qty: 5, ref_id: null, ref_type: 'initial', note: 'Stock initial' };
    const first = await client.rpc('create_product_with_stock', { p_product: row(businessId, userId, id), p_stock_move: move });
    expect(first.error).toBeNull();
    const replay = await client.rpc('create_product_with_stock', { p_product: row(businessId, userId, id), p_stock_move: move });
    expect(replay.error).toBeNull();
    expect(replay.data).toBe(id);
    const admin = adminClient();
    const { data: products } = await admin.from('products').select('id').eq('id', id);
    expect(products).toHaveLength(1);
    const { data: moves } = await admin.from('stock_moves').select('id').eq('product_id', id);
    expect(moves).toHaveLength(1);
  });

  it('CROSS-BUSINESS: a product id that exists in ANOTHER business is refused, not adopted', async () => {
    const victim = await createTestUser('v');
    const victimBiz = await createTestBusiness(victim.client, 'Victim');
    const id = randomUUID();
    await victim.client.rpc('create_product_with_stock', { p_product: row(victimBiz, victim.userId, id), p_stock_move: null });
    const attacker = await createTestUser('a');
    const attackerBiz = await createTestBusiness(attacker.client, 'Attacker');
    const { error } = await attacker.client.rpc('create_product_with_stock', { p_product: row(attackerBiz, attacker.userId, id), p_stock_move: null });
    expect(error).not.toBeNull();
  });
});

describe('adjust_stock_move (v243)', () => {
  it('is RELATIVE: applies +/- qty to the CURRENT stock, floors at 0', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'B');
    const productId = await createTestProduct(businessId, userId, { stock_qty: 10 });
    const out = await client.rpc('adjust_stock_move', { p_business_id: businessId, p_product_id: productId, p_type: 'perte', p_qty: 3, p_move_id: randomUUID() });
    expect(out.error).toBeNull();
    expect(Number(out.data)).toBe(7);
    // stock moved meanwhile (a sale) — a later queued adjustment applies on top, not over it
    await adminClient().from('products').update({ stock_qty: 4 }).eq('id', productId);
    await client.rpc('adjust_stock_move', { p_business_id: businessId, p_product_id: productId, p_type: 'entree', p_qty: 2, p_move_id: randomUUID() });
    expect(await getProductStock(productId)).toBe(6);
    await client.rpc('adjust_stock_move', { p_business_id: businessId, p_product_id: productId, p_type: 'perte', p_qty: 99, p_move_id: randomUUID() });
    expect(await getProductStock(productId)).toBe(0);
  });

  it('a replay of the same move id changes nothing and writes no second stock move', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'B');
    const productId = await createTestProduct(businessId, userId, { stock_qty: 10 });
    const moveId = randomUUID();
    const args = { p_business_id: businessId, p_product_id: productId, p_type: 'perte', p_qty: 3, p_move_id: moveId };
    await client.rpc('adjust_stock_move', args);
    const replay = await client.rpc('adjust_stock_move', args);
    expect(replay.error).toBeNull();
    expect(Number(replay.data)).toBe(7);
    expect(await getProductStock(productId)).toBe(7);
    const { data: moves } = await adminClient().from('stock_moves').select('id').eq('id', moveId);
    expect(moves).toHaveLength(1);
  });

  it('CROSS-BUSINESS: cannot adjust another business\'s product (even naming your own business id)', async () => {
    const victim = await createTestUser('v');
    const victimBiz = await createTestBusiness(victim.client, 'Victim');
    const victimProduct = await createTestProduct(victimBiz, victim.userId, { stock_qty: 50 });
    const attacker = await createTestUser('a');
    const attackerBiz = await createTestBusiness(attacker.client, 'Attacker');
    const viaOwnBiz = await attacker.client.rpc('adjust_stock_move', { p_business_id: attackerBiz, p_product_id: victimProduct, p_type: 'perte', p_qty: 10, p_move_id: randomUUID() });
    expect(viaOwnBiz.error).not.toBeNull();
    const viaVictimBiz = await attacker.client.rpc('adjust_stock_move', { p_business_id: victimBiz, p_product_id: victimProduct, p_type: 'perte', p_qty: 10, p_move_id: randomUUID() });
    expect(viaVictimBiz.error).not.toBeNull();
    expect(await getProductStock(victimProduct)).toBe(50);
  });

  it('a vendeur cannot adjust stock; invalid type / qty rejected', async () => {
    const admin = await createTestUser('admin');
    const businessId = await createTestBusiness(admin.client, 'B');
    const productId = await createTestProduct(businessId, admin.userId, { stock_qty: 10 });
    const seller = await createTestUser('seller');
    await addMember(businessId, seller.userId, 'vendeur');
    expect((await seller.client.rpc('adjust_stock_move', { p_business_id: businessId, p_product_id: productId, p_type: 'perte', p_qty: 1 })).error).not.toBeNull();
    expect((await admin.client.rpc('adjust_stock_move', { p_business_id: businessId, p_product_id: productId, p_type: 'bogus', p_qty: 1 })).error).not.toBeNull();
    expect((await admin.client.rpc('adjust_stock_move', { p_business_id: businessId, p_product_id: productId, p_type: 'perte', p_qty: 0 })).error).not.toBeNull();
    expect(await getProductStock(productId)).toBe(10);
  });
});

describe('pay_supplier_debt idempotency (v243)', () => {
  it('records once: a replay with the same key allocates nothing and logs no second payment', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'B');
    const { supplierId, debtId } = await supplierWithDebt(client, businessId, userId, 100000);
    const key = randomUUID();
    const args = { p_business_id: businessId, p_supplier_id: supplierId, p_amount_cents: 40000, p_idempotency_key: key };
    const first = await client.rpc('pay_supplier_debt', args);
    expect(first.error).toBeNull();
    expect((first.data as { remaining_cents: number }).remaining_cents).toBe(0);
    const replay = await client.rpc('pay_supplier_debt', args);
    expect(replay.error).toBeNull();
    expect((replay.data as { replayed?: boolean }).replayed).toBe(true);
    const admin = adminClient();
    const { data: debt } = await admin.from('supplier_debts').select('amount_paid').eq('id', debtId).single();
    expect((debt as { amount_paid: number }).amount_paid).toBe(40000);
    const { data: payments } = await admin.from('supplier_payments').select('amount_cents').eq('supplier_id', supplierId);
    expect(payments).toHaveLength(1);
  });

  it('without a key it behaves exactly as before (two payments = two allocations)', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'B');
    const { supplierId, debtId } = await supplierWithDebt(client, businessId, userId, 100000);
    await client.rpc('pay_supplier_debt', { p_business_id: businessId, p_supplier_id: supplierId, p_amount_cents: 10000 });
    await client.rpc('pay_supplier_debt', { p_business_id: businessId, p_supplier_id: supplierId, p_amount_cents: 10000 });
    const { data: debt } = await adminClient().from('supplier_debts').select('amount_paid').eq('id', debtId).single();
    expect((debt as { amount_paid: number }).amount_paid).toBe(20000);
  });

  it('CROSS-BUSINESS: cannot pay another business\'s supplier debt', async () => {
    const victim = await createTestUser('v');
    const victimBiz = await createTestBusiness(victim.client, 'Victim');
    const { supplierId, debtId } = await supplierWithDebt(victim.client, victimBiz, victim.userId, 100000);
    const attacker = await createTestUser('a');
    const attackerBiz = await createTestBusiness(attacker.client, 'Attacker');
    // naming own business with the victim's supplier: nothing to allocate there
    const own = await attacker.client.rpc('pay_supplier_debt', { p_business_id: attackerBiz, p_supplier_id: supplierId, p_amount_cents: 50000, p_idempotency_key: randomUUID() });
    expect((own.data as { remaining_cents?: number } | null)?.remaining_cents ?? 50000).toBe(50000);
    const direct = await attacker.client.rpc('pay_supplier_debt', { p_business_id: victimBiz, p_supplier_id: supplierId, p_amount_cents: 50000 });
    expect(direct.error).not.toBeNull();
    const { data: debt } = await adminClient().from('supplier_debts').select('amount_paid').eq('id', debtId).single();
    expect((debt as { amount_paid: number }).amount_paid).toBe(0);
  });

  it('a vendeur cannot pay supplier debts', async () => {
    const admin = await createTestUser('admin');
    const businessId = await createTestBusiness(admin.client, 'B');
    const { supplierId } = await supplierWithDebt(admin.client, businessId, admin.userId, 100000);
    const seller = await createTestUser('seller');
    await addMember(businessId, seller.userId, 'vendeur');
    expect((await seller.client.rpc('pay_supplier_debt', { p_business_id: businessId, p_supplier_id: supplierId, p_amount_cents: 1000 })).error).not.toBeNull();
  });
});

describe('create_supplier_debt replay (row id is the key)', () => {
  it('re-inserting the same debt id is a unique violation (23505) the client treats as success — never a second debt', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'B');
    const { supplierId } = await supplierWithDebt(client, businessId, userId, 1000);
    const id = randomUUID();
    const row = { id, business_id: businessId, supplier_id: supplierId, amount: 5000, amount_paid: 0, date: '2026-10-07', created_by: userId };
    expect((await client.from('supplier_debts').insert(row)).error).toBeNull();
    const again = await client.from('supplier_debts').insert(row);
    expect((again.error as { code?: string } | null)?.code).toBe('23505');
    const { data } = await adminClient().from('supplier_debts').select('id').eq('id', id);
    expect(data).toHaveLength(1);
  });
});
