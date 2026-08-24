// Exercises the real receive_purchase_order() Postgres function for
// variant-tagged PO lines (AVCO must land on the specific variant, never the
// parent or a sibling variant), plus the reconciliation checks that guard
// this area: 81/82 (variant price sanity) and 83 (a received line on a
// variant product with no variant assigned — the exact shape of bug fixed
// in app/(app)/fournisseurs/[id].tsx's CommandeForm, which used to build a
// per-variant line on screen and then silently drop variant_id before
// saving it).
import {
  createTestUser, createTestBusiness, createTestProduct, createTestVariant, adminClient,
} from './helpers';
import { randomUUID } from 'crypto';

async function createSupplier(businessId: string, createdBy: string): Promise<string> {
  const admin = adminClient();
  const id = randomUUID();
  const { error } = await admin.from('suppliers').insert({
    id, business_id: businessId, name: 'Fournisseur Test', created_by: createdBy,
  });
  if (error) throw error;
  return id;
}

async function createPO(businessId: string, supplierId: string, createdBy: string): Promise<string> {
  const admin = adminClient();
  const id = randomUUID();
  const { error } = await admin.from('purchase_orders').insert({
    id, business_id: businessId, supplier_id: supplierId, status: 'brouillon', created_by: createdBy,
  });
  if (error) throw error;
  return id;
}

async function createPOLine(poId: string, productId: string, opts: {
  variantId?: string | null; qtyOrdered: number; unitCost: number;
}): Promise<string> {
  const admin = adminClient();
  const id = randomUUID();
  const { error } = await admin.from('po_lines').insert({
    id, po_id: poId, product_id: productId,
    variant_id: opts.variantId ?? null,
    qty_ordered: opts.qtyOrdered, qty_received: 0, unit_cost: opts.unitCost,
  });
  if (error) throw error;
  return id;
}

async function getVariant(variantId: string) {
  const admin = adminClient();
  const { data, error } = await admin.from('product_variants').select('*').eq('id', variantId).single();
  if (error) throw error;
  return data as { stock_qty: number; cost_price: number };
}

async function getProduct(productId: string) {
  const admin = adminClient();
  const { data, error } = await admin.from('products').select('*').eq('id', productId).single();
  if (error) throw error;
  return data as { stock_qty: number; cost_price: number };
}

async function runReconciliationAndVariantChecks(): Promise<string> {
  const admin = adminClient();
  const { data: runId, error: runErr } = await admin.rpc('run_reconciliation');
  if (runErr) throw runErr;
  const { error: variantErr } = await admin.rpc('run_variant_price_checks', { p_run_id: runId });
  if (variantErr) throw variantErr;
  return runId as string;
}

async function findingsFor(runId: string, checkId: number, entityId: string) {
  const admin = adminClient();
  const { data, error } = await admin
    .from('reconciliation_findings')
    .select('*')
    .eq('run_id', runId)
    .eq('check_id', checkId)
    .eq('entity_id', entityId);
  if (error) throw error;
  return data ?? [];
}

describe('receive_purchase_order — variant tracking (real RPC)', () => {
  it('a variant-tagged line updates only that variant, never the parent or the sibling variant', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const productId = await createTestProduct(businessId, userId, { name: 'T-shirt', cost_price: 0, sale_price: 2000 });
    const redId = await createTestVariant(productId, businessId, { name: 'Rouge', stock_qty: 10, cost_price: 500 });
    const blueId = await createTestVariant(productId, businessId, { name: 'Bleu', stock_qty: 10, cost_price: 500 });
    const supplierId = await createSupplier(businessId, userId);
    const poId = await createPO(businessId, supplierId, userId);
    // po_lines.unit_cost is display units, not cents (the RPC itself does the
    // ×100 conversion internally) — 7 here lands as 700 cents, giving a new
    // AVCO cost of (10*500 + 10*700)/20 = 600.
    const lineId = await createPOLine(poId, productId, { variantId: redId, qtyOrdered: 10, unitCost: 7 });

    const { error } = await client.rpc('receive_purchase_order', {
      p_po_id: poId, p_business_id: businessId,
      p_line_ids: [lineId], p_line_qtys: [10],
    });
    expect(error).toBeNull();

    const red = await getVariant(redId);
    expect(red.stock_qty).toBe(20);
    expect(red.cost_price).toBe(600); // AVCO, not overwritten flat

    // The sibling variant must be completely untouched.
    const blue = await getVariant(blueId);
    expect(blue.stock_qty).toBe(10);
    expect(blue.cost_price).toBe(500);
    // The parent's own stock_qty legitimately still bumps as a receipt
    // counter even on a variant-tagged line (receive_purchase_order does
    // this unconditionally — real, intentional behavior, not a bug) — but
    // its cost_price must never move in the variant branch, since AVCO only
    // ever writes cost_price onto the specific variant here.
    const parent = await getProduct(productId);
    expect(parent.stock_qty).toBe(10);
    expect(parent.cost_price).toBe(0);
  });

  it('a line with no variant_id on a variant product routes stock/cost to the parent — the exact bug shape check 83 exists to catch', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const productId = await createTestProduct(businessId, userId, { name: 'Casquette', cost_price: 0, sale_price: 1500 });
    await createTestVariant(productId, businessId, { name: 'Unique', stock_qty: 5, cost_price: 400 });
    const supplierId = await createSupplier(businessId, userId);
    const poId = await createPO(businessId, supplierId, userId);
    const lineId = await createPOLine(poId, productId, { variantId: null, qtyOrdered: 5, unitCost: 300 });

    const { error } = await client.rpc('receive_purchase_order', {
      p_po_id: poId, p_business_id: businessId,
      p_line_ids: [lineId], p_line_qtys: [5],
    });
    expect(error).toBeNull();

    // Confirms the failure mode: the parent's stock_qty (meant to always stay
    // 0 for a variant product) moved, proving this data state is real and
    // reachable, not hypothetical.
    const parent = await getProduct(productId);
    expect(parent.stock_qty).toBe(5);

    const runId = await runReconciliationAndVariantChecks();
    const findings = await findingsFor(runId, 83, lineId);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warning');
  });

  it('check 83 does not fire for a properly variant-tagged received line (no false positive)', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const productId = await createTestProduct(businessId, userId, { name: 'Sandales', cost_price: 0, sale_price: 1200 });
    const variantId = await createTestVariant(productId, businessId, { name: '42', stock_qty: 3, cost_price: 300 });
    const supplierId = await createSupplier(businessId, userId);
    const poId = await createPO(businessId, supplierId, userId);
    const lineId = await createPOLine(poId, productId, { variantId, qtyOrdered: 5, unitCost: 350 });

    await client.rpc('receive_purchase_order', {
      p_po_id: poId, p_business_id: businessId,
      p_line_ids: [lineId], p_line_qtys: [5],
    });

    const runId = await runReconciliationAndVariantChecks();
    const findings = await findingsFor(runId, 83, lineId);
    expect(findings).toHaveLength(0);
  });
});

describe('run_variant_price_checks — 81/82 (real RPC, planted trap cases)', () => {
  it('flags a variant priced below its own cost (81) and a ×100-forgotten variant price (82), never a correctly priced one', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const productId = await createTestProduct(businessId, userId, { name: 'Robe', cost_price: 0, sale_price: 0 });
    const belowCostId = await createTestVariant(productId, businessId, { name: 'Sous cout', sale_price: 300, cost_price: 700 });
    const typoId = await createTestVariant(productId, businessId, { name: 'Typo x100', sale_price: 15, cost_price: 700 });
    const normalId = await createTestVariant(productId, businessId, { name: 'Normal', sale_price: 1600, cost_price: 700 });

    const runId = await runReconciliationAndVariantChecks();

    expect(await findingsFor(runId, 81, belowCostId)).toHaveLength(1);
    expect(await findingsFor(runId, 81, typoId)).toHaveLength(1); // 15 < 700 too, correctly also a real loss
    expect(await findingsFor(runId, 82, typoId)).toHaveLength(1);
    expect(await findingsFor(runId, 81, normalId)).toHaveLength(0);
    expect(await findingsFor(runId, 82, normalId)).toHaveLength(0);
  });
});
