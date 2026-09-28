// Exercises the real submit_carnet_debt() Postgres function's client_id
// parameter (migration_v160.sql) — this used to not exist at all, so a debt
// added via Vendre's "Crédit rapide" tab or the onboarding carnet import
// never attached to a real client row, and the client balance shown in that
// same tab (computed by filtering strictly on client_id, no name fallback)
// silently excluded every debt ever added this way.
import { createTestUser, createTestBusiness, adminClient } from './helpers';
import { randomUUID } from 'crypto';

async function createClient(businessId: string, createdBy: string, name: string): Promise<string> {
  const admin = adminClient();
  const id = randomUUID();
  const { error } = await admin.from('clients').insert({ id, business_id: businessId, name, created_by: createdBy });
  if (error) throw error;
  return id;
}

async function creditBalance(businessId: string, clientId: string): Promise<number> {
  const admin = adminClient();
  const { data, error } = await admin
    .from('sale_orders')
    .select('total_amount')
    .eq('business_id', businessId)
    .eq('client_id', clientId)
    .eq('status', 'credit');
  if (error) throw error;
  return (data ?? []).reduce((s, r) => s + (r.total_amount as number), 0);
}

describe('submit_carnet_debt — client_id (real RPC)', () => {
  it('attaches the debt to a real client, and the client-scoped balance query picks it up', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const clientId = await createClient(businessId, userId, 'Mamadou');

    const { data: orderId, error } = await client.rpc('submit_carnet_debt', {
      p_business_id: businessId,
      p_seller_id: userId,
      p_customer_name: 'Mamadou',
      p_amount: 500000, // 5000 GNF in cents
      p_client_id: clientId,
    });
    expect(error).toBeNull();

    const admin = adminClient();
    const { data: order } = await admin.from('sale_orders').select('client_id').eq('id', orderId as string).single();
    expect(order?.client_id).toBe(clientId);

    // The exact shape of query Vendre's carnet tab uses to show a returning
    // client's balance — this is what silently read 0 before the fix.
    expect(await creditBalance(businessId, clientId)).toBe(500000);
  });

  it('still works with no client attached (p_client_id omitted) — backward compatible', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');

    const { data: orderId, error } = await client.rpc('submit_carnet_debt', {
      p_business_id: businessId,
      p_seller_id: userId,
      p_customer_name: 'Client sans fiche',
      p_amount: 100000,
    });
    expect(error).toBeNull();

    const admin = adminClient();
    const { data: order } = await admin.from('sale_orders').select('client_id, total_amount').eq('id', orderId as string).single();
    expect(order?.client_id).toBeNull();
    expect(order?.total_amount).toBe(100000);
  });

  it('two debts for the same client accumulate into one correct balance', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const clientId = await createClient(businessId, userId, 'Fatoumata');

    await client.rpc('submit_carnet_debt', {
      p_business_id: businessId, p_seller_id: userId,
      p_customer_name: 'Fatoumata', p_amount: 200000, p_client_id: clientId,
    });
    await client.rpc('submit_carnet_debt', {
      p_business_id: businessId, p_seller_id: userId,
      p_customer_name: 'Fatoumata', p_amount: 150000, p_client_id: clientId,
    });

    expect(await creditBalance(businessId, clientId)).toBe(350000);
  });
});

// migration_v178.sql — real idempotency on submit_carnet_debt, mirroring
// submit_sale's existing guard (migration_v122.sql). Needed once the client
// (stores/sales.ts) started queueing a failed-offline debt into the SQLite
// sync_queue and replaying it later: without server-side dedup, a replay of
// a call that actually succeeded before the client saw the network error
// would silently double-record the debt.
describe('submit_carnet_debt — idempotency (migration_v178.sql)', () => {
  it('retrying with the same idempotency key returns the same order, no duplicate row', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');
    const idempotencyKey = randomUUID();

    const first = await client.rpc('submit_carnet_debt', {
      p_business_id: businessId, p_seller_id: userId,
      p_customer_name: 'Ibrahima', p_amount: 300000,
      p_idempotency_key: idempotencyKey,
    });
    const second = await client.rpc('submit_carnet_debt', {
      p_business_id: businessId, p_seller_id: userId,
      p_customer_name: 'Ibrahima', p_amount: 300000,
      p_idempotency_key: idempotencyKey,
    });

    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(second.data).toBe(first.data);

    const admin = adminClient();
    const { data: orders } = await admin.from('sale_orders')
      .select('id')
      .eq('business_id', businessId)
      .eq('idempotency_key', idempotencyKey);
    expect(orders).toHaveLength(1); // not double-recorded

    const { data: lines } = await admin.from('so_lines').select('id').eq('order_id', first.data as string);
    expect(lines).toHaveLength(1); // no duplicate line either
  });

  it('reuses the single "Solde reporté" system product across retries — never creates a second one', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');

    await client.rpc('submit_carnet_debt', {
      p_business_id: businessId, p_seller_id: userId,
      p_customer_name: 'A', p_amount: 100000, p_idempotency_key: randomUUID(),
    });
    await client.rpc('submit_carnet_debt', {
      p_business_id: businessId, p_seller_id: userId,
      p_customer_name: 'B', p_amount: 200000, p_idempotency_key: randomUUID(),
    });

    const admin = adminClient();
    const { data: systemProducts } = await admin.from('products')
      .select('id')
      .eq('business_id', businessId)
      .eq('is_system', true);
    expect(systemProducts).toHaveLength(1);
  });

  it('a genuinely repeated debt (different key, same customer/amount) is NOT deduplicated', async () => {
    // The other half of the guard: distinguishes a real retry (same key)
    // from two real, separate debts for the same person, which must both
    // be recorded — an over-eager dedup here would silently drop a
    // legitimate second debt.
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');

    const first = await client.rpc('submit_carnet_debt', {
      p_business_id: businessId, p_seller_id: userId,
      p_customer_name: 'Mariama', p_amount: 150000, p_idempotency_key: randomUUID(),
    });
    const second = await client.rpc('submit_carnet_debt', {
      p_business_id: businessId, p_seller_id: userId,
      p_customer_name: 'Mariama', p_amount: 150000, p_idempotency_key: randomUUID(),
    });

    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(first.data).not.toBe(second.data);

    const admin = adminClient();
    const { data: orders } = await admin.from('sale_orders')
      .select('id')
      .eq('business_id', businessId)
      .eq('customer_name', 'Mariama');
    expect(orders).toHaveLength(2);
  });
});

// Verifies the real nightly reconciliation pipeline (run_reconciliation(),
// db/migration_v99.sql — 68+ checks, including #15 "duplicate idempotency
// keys for non-cancelled sales") sees this flow as clean, not just that our
// own assertions above agree with each other. Scoped to this test's own
// business_id so it's immune to whatever other data exists in the local
// test database from other integration test files.
describe('submit_carnet_debt — reconciliation (run_reconciliation)', () => {
  it('a normal debt plus an idempotent-replay duplicate raises zero findings for this business', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Test');

    // One real debt, submitted twice with the same key — simulates an
    // offline-queue replay firing after the original call already
    // committed server-side (the exact scenario the idempotency guard
    // exists to make safe).
    const key = randomUUID();
    await client.rpc('submit_carnet_debt', {
      p_business_id: businessId, p_seller_id: userId,
      p_customer_name: 'Test Reconciliation', p_amount: 400000, p_idempotency_key: key,
    });
    await client.rpc('submit_carnet_debt', {
      p_business_id: businessId, p_seller_id: userId,
      p_customer_name: 'Test Reconciliation', p_amount: 400000, p_idempotency_key: key,
    });

    const admin = adminClient();
    const { data: runId, error: runErr } = await admin.rpc('run_reconciliation');
    expect(runErr).toBeNull();

    const { data: findings, error: findErr } = await admin
      .from('reconciliation_findings')
      .select('check_id, severity, detail')
      .eq('run_id', runId as string)
      .eq('business_id', businessId);
    expect(findErr).toBeNull();
    expect(findings).toHaveLength(0);
  }, 30000); // run_reconciliation scans every business in the local DB — longer than the default 5s timeout
});
