// Security audit 2026-09-27, checklist 1.1 (BOLA/IDOR) — resolve_reception_supplier()
// (migration_v188.sql) had no membership check of its own. Both of its real
// callers (confirm_reception, update_reception_supplier) already gate on
// get_role() before calling it, but Postgres grants EXECUTE on a new
// SECURITY DEFINER function to PUBLIC (which includes authenticated) by
// default — so it was directly callable standalone against an arbitrary
// business_id by anyone with a session, letting a non-member write a bogus
// "Marché" supplier row into a business they don't belong to.
import { createTestUser, createTestBusiness } from './helpers';

describe('resolve_reception_supplier (real RPC) — IDOR', () => {
  it('rejects a caller who is not a member of the target business, and creates nothing', async () => {
    const { client: ownerClient, userId: ownerId } = await createTestUser('owner');
    const businessId = await createTestBusiness(ownerClient, 'Boutique Victime');

    const { client: outsiderClient } = await createTestUser('outsider');

    const { data, error } = await outsiderClient.rpc('resolve_reception_supplier', {
      p_business_id: businessId,
      p_supplier_id: null,
    });

    expect(error).toBeTruthy();
    expect(error!.message).toMatch(/Accès refusé/);
    expect(data).toBeFalsy();

    // No "Marché" placeholder (or anything else) should have been created
    // in the victim business as a side effect of the rejected call.
    const { data: suppliers } = await ownerClient.from('suppliers').select('id').eq('business_id', businessId);
    expect(suppliers).toHaveLength(0);
    void ownerId;
  });

  it('still works for a genuine member (no regression)', async () => {
    const { client, userId } = await createTestUser('admin2');
    const businessId = await createTestBusiness(client, 'Boutique Test');

    const { data: supplierId, error } = await client.rpc('resolve_reception_supplier', {
      p_business_id: businessId,
      p_supplier_id: null,
    });

    expect(error).toBeNull();
    expect(supplierId).toBeTruthy();

    const { data: supplier } = await client.from('suppliers').select('name').eq('id', supplierId).single();
    expect(supplier!.name).toBe('Marché');
    void userId;
  });
});
