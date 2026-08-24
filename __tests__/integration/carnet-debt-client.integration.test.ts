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
