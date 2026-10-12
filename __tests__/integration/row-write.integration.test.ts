// The row_write executor (lib/rowWriteExec.ts) against real Postgres + real RLS, through a signed-in user client.
import { createTestUser, createTestBusiness, createTestProduct, adminClient } from './helpers';
import { executeRowWrite } from '../../lib/rowWriteExec';
import { randomUUID } from 'crypto';

const key = () => randomUUID();

describe('row_write against real Postgres', () => {
  it('profiles: display field update is last-writer-wins and scoped to the caller', async () => {
    const { client, userId } = await createTestUser('rw1');
    await executeRowWrite(client, { p_idempotency_key: key(), table: 'profiles', op: 'update', values: { name: 'Premier' }, match: { id: userId } });
    await executeRowWrite(client, { p_idempotency_key: key(), table: 'profiles', op: 'update', values: { name: 'Dernier' }, match: { id: userId } });
    const { data } = await adminClient().from('profiles').select('name').eq('id', userId).single();
    expect(data?.name).toBe('Dernier');
  });

  it('profiles: another user\'s row is untouched (RLS filters it; no error, no effect)', async () => {
    const a = await createTestUser('rw2a');
    const b = await createTestUser('rw2b');
    await adminClient().from('profiles').update({ name: 'Intact' }).eq('id', b.userId);
    await executeRowWrite(a.client, { p_idempotency_key: key(), table: 'profiles', op: 'update', values: { name: 'Pirate' }, match: { id: b.userId } });
    const { data } = await adminClient().from('profiles').select('name').eq('id', b.userId).single();
    expect(data?.name).toBe('Intact');
  });

  it('clients: upsert by (business, name) is idempotent — a replay never duplicates, and keeps one row', async () => {
    const { client, userId } = await createTestUser('rw3');
    const biz = await createTestBusiness(client, 'Boutique RW');
    const payload = () => ({ p_idempotency_key: key(), table: 'clients', op: 'upsert', values: { business_id: biz, name: 'Awa Diallo', created_by: userId }, match: {} });
    await executeRowWrite(client, payload());
    await executeRowWrite(client, payload());
    const { data } = await adminClient().from('clients').select('id').eq('business_id', biz).eq('name', 'Awa Diallo');
    expect(data).toHaveLength(1);
  });

  it('product_suppliers: duplicate link insert counts as success; delete of an absent link is a no-op', async () => {
    const { client, userId } = await createTestUser('rw4');
    const biz = await createTestBusiness(client, 'Boutique Liens');
    const productId = await createTestProduct(biz, userId, {});
    const { data: sup } = await adminClient().from('suppliers').insert({ business_id: biz, name: 'Grossiste', created_by: userId }).select('id').single();
    const link = { table: 'product_suppliers', op: 'insert', values: { product_id: productId, supplier_id: sup!.id }, match: {} };
    await executeRowWrite(client, { p_idempotency_key: key(), ...link });
    await expect(executeRowWrite(client, { p_idempotency_key: key(), ...link })).resolves.toBeUndefined(); // 23505 → success
    await executeRowWrite(client, { p_idempotency_key: key(), table: 'product_suppliers', op: 'delete', values: {}, match: { product_id: productId, supplier_id: sup!.id } });
    await executeRowWrite(client, { p_idempotency_key: key(), table: 'product_suppliers', op: 'delete', values: {}, match: { product_id: productId, supplier_id: sup!.id } });
    const { data } = await adminClient().from('product_suppliers').select('product_id').eq('product_id', productId);
    expect(data).toHaveLength(0);
  });

  it('an RLS-refused insert surfaces as a permanent business rejection (P0001) — never retried forever', async () => {
    const a = await createTestUser('rw5a');
    const b = await createTestUser('rw5b');
    const bizB = await createTestBusiness(b.client, 'Autre boutique');
    await expect(executeRowWrite(a.client, {
      p_idempotency_key: key(), table: 'clients', op: 'insert', values: { id: randomUUID(), business_id: bizB, name: 'Intrus', created_by: a.userId }, match: {},
    })).rejects.toMatchObject({ code: 'P0001' });
  });
});
