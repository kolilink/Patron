// edit_withdrawal (migration_v224) — real RPC against local Postgres.
//
// Withdrawals were append-only; a fat-fingered amount could only be "fixed" by
// recording yet another compensating row, silently corrupting ledger history.
// edit_withdrawal() lets an admin/manager correct an EXISTING negative row:
//   - stores the positive input as negative (signed-amount invariant),
//   - refuses to touch a positive (injection) row,
//   - refuses a non-positive amount,
//   - stamps edited_at/edited_by,
//   - is admin/manager-only (same role gate as edit_injection).
import { createTestUser, createTestBusiness, addMember, adminClient } from './helpers';

async function recordWithdrawal(
    client: any,
    businessId: string,
    amountCents: number,
    note?: string,
    date?: string,
): Promise<string> {
    const { data, error } = await client.rpc('record_withdrawal', {
        p_business_id: businessId,
        p_amount: amountCents,
        p_injected_by_id: null,
        p_source_name: null,
        p_note: note ?? null,
        p_withdrawn_at: date ?? '2026-01-01',
    });
    if (error) throw error;
    return data as string;
}

async function getRow(id: string): Promise<Record<string, any>> {
    const admin = adminClient();
    const { data, error } = await admin.from('capital_injections')
        .select('amount, note, injected_at, edited_at, edited_by')
        .eq('id', id)
        .single();
    if (error) throw error;
    return data;
}

describe('edit_withdrawal (real RPC)', () => {
    it('corrects amount/note/date and stores the amount negative with an edit stamp', async () => {
        const { client, userId } = await createTestUser('admin');
        const businessId = await createTestBusiness(client, 'Boutique Retrait');
        const id = await recordWithdrawal(client, businessId, 100000, 'Erreur', '2026-01-01');

        const { error } = await client.rpc('edit_withdrawal', {
            p_id: id,
            p_amount: 50000,
            p_injected_by_id: null,
            p_source_name: null,
            p_note: 'Correction',
            p_withdrawn_at: '2026-02-02',
        });

        expect(error).toBeNull();

        const row = await getRow(id);
        expect(row.amount).toBe(-50000);           // positive input stored negative
        expect(row.note).toBe('Correction');
        expect(row.injected_at).toBe('2026-02-02'); // date corrected
        expect(row.edited_at).toBeTruthy();
        expect(row.edited_by).toBe(userId);
    });

    it('rejects a non-positive amount (p_amount <= 0)', async () => {
        const { client } = await createTestUser('admin');
        const businessId = await createTestBusiness(client, 'Boutique Retrait2');
        const id = await recordWithdrawal(client, businessId, 100000);

        const { error } = await client.rpc('edit_withdrawal', {
            p_id: id,
            p_amount: 0,
            p_injected_by_id: null,
            p_source_name: null,
            p_note: null,
            p_withdrawn_at: null,
        });

        expect(error).toBeTruthy();
        expect(error!.message).toMatch(/positif/);

        const row = await getRow(id);
        expect(row.amount).toBe(-100000); // untouched
    });

    it('refuses to edit an injection (positive row)', async () => {
        const { client } = await createTestUser('admin');
        const businessId = await createTestBusiness(client, 'Boutique Retrait3');

        const { data: injectionId, error: recErr } = await client.rpc('record_injection', {
            p_business_id: businessId,
            p_amount: 100000,
            p_injected_by_id: null,
            p_source_name: null,
            p_note: null,
            p_injected_at: '2026-01-01',
        });
        expect(recErr).toBeNull();

        const { error } = await client.rpc('edit_withdrawal', {
            p_id: injectionId,
            p_amount: 50000,
            p_injected_by_id: null,
            p_source_name: null,
            p_note: null,
            p_withdrawn_at: null,
        });

        expect(error).toBeTruthy();
        expect(error!.message).toMatch(/pas un retrait/);

        const row = await getRow(injectionId);
        expect(row.amount).toBe(100000); // untouched
    });

    it('is admin/manager-only — a vendeur cannot edit a withdrawal', async () => {
        const { client: adminC } = await createTestUser('admin');
        const businessId = await createTestBusiness(adminC, 'Boutique Retrait4');
        const id = await recordWithdrawal(adminC, businessId, 100000);

        const { client: sellerC, userId: sellerId } = await createTestUser('vendeur');
        await addMember(businessId, sellerId, 'vendeur');

        const { error } = await sellerC.rpc('edit_withdrawal', {
            p_id: id,
            p_amount: 50000,
            p_injected_by_id: null,
            p_source_name: null,
            p_note: null,
            p_withdrawn_at: null,
        });

        expect(error).toBeTruthy();
        expect(error!.message).toMatch(/Accès refusé/);

        const row = await getRow(id);
        expect(row.amount).toBe(-100000); // untouched
    });
});
