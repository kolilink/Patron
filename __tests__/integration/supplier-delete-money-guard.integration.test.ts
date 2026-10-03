// P0-2: supplier delete destroys money (migration_v213).
//
// supplier_debts.supplier_id and supplier_payments.supplier_id were
// ON DELETE CASCADE — deleting a supplier with an unpaid debt silently
// erased money the business is owed. Deleting a supplier with purchase
// orders instead surfaced a raw FK violation, flattened into a generic
// "impossible" message by the client.
//
// migration_v213 adds a BEFORE DELETE trigger on suppliers that raises
// distinct, truthful French messages.

import { adminClient, createTestBusiness, createTestUser } from './helpers';
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

async function createDebt(businessId: string, supplierId: string, createdBy: string): Promise<void> {
    const admin = adminClient();
    const { error } = await admin.from('supplier_debts').insert({
        business_id: businessId,
        supplier_id: supplierId,
        amount: 100000,
        amount_paid: 0,
        date: new Date().toISOString().slice(0, 10),
        created_by: createdBy,
    });
    if (error) throw error;
}

async function createPO(businessId: string, supplierId: string, createdBy: string): Promise<void> {
    const admin = adminClient();
    const { error } = await admin.from('purchase_orders').insert({
        business_id: businessId,
        supplier_id: supplierId,
        status: 'brouillon',
        created_by: createdBy,
    });
    if (error) throw error;
}

async function supplierExists(id: string): Promise<boolean> {
    const admin = adminClient();
    const { data } = await admin.from('suppliers').select('id').eq('id', id).single();
    return !!data;
}

describe('supplier delete money guard (real RLS + trigger, migration_v213)', () => {
    it('blocks deleting a supplier with an unpaid debt, naming the money consequence', async () => {
        const { client, userId } = await createTestUser('sup-del-debt');
        const businessId = await createTestBusiness(client, 'Boutique dette');
        const supplierId = await createSupplier(businessId, userId);
        await createDebt(businessId, supplierId, userId);

        const { error } = await client
            .from('suppliers')
            .delete()
            .eq('id', supplierId)
            .eq('business_id', businessId);

        expect(error).toBeTruthy();
        expect(error!.message).toContain('effacerait cet argent dû');
        await expect(supplierExists(supplierId)).resolves.toBe(true);
    });

    it('blocks deleting a supplier with purchase orders, naming the exact blocker', async () => {
        const { client, userId } = await createTestUser('sup-del-po');
        const businessId = await createTestBusiness(client, 'Boutique commande');
        const supplierId = await createSupplier(businessId, userId);
        await createPO(businessId, supplierId, userId);

        const { error } = await client
            .from('suppliers')
            .delete()
            .eq('id', supplierId)
            .eq('business_id', businessId);

        expect(error).toBeTruthy();
        expect(error!.message).toContain('commandes fournisseur');
        await expect(supplierExists(supplierId)).resolves.toBe(true);
    });

    it('allows deleting a supplier with no unpaid debt and no purchase orders', async () => {
        const { client, userId } = await createTestUser('sup-del-ok');
        const businessId = await createTestBusiness(client, 'Boutique libre');
        const supplierId = await createSupplier(businessId, userId);

        const { error } = await client
            .from('suppliers')
            .delete()
            .eq('id', supplierId)
            .eq('business_id', businessId);

        expect(error).toBeNull();
        await expect(supplierExists(supplierId)).resolves.toBe(false);
    });
});
