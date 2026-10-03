// E2E FIX BATCH E — social & reports (migration_v219). TEST DB only — do not commit.
//
// Server-testable fixes in this batch:
//   fix #5 — get_dashboard_kpis() now counts credit sales in sales_today
//            (and keeps credit out of revenue_today), matching Accueil's
//            local computeLocalKpis formula so the "N ventes aujourd'hui"
//            figure no longer flips down a beat after render.
//   fix #3 — remove_partnership()'s DELETE cascades through
//            chat_rooms.partnership_id → chat_messages.room_id, so an
//            unfriend no longer leaves a dead DM room with stale messages.
//
// Fixes #1 (block author hides posts), #2 (report hides post) and #4
// (offline support queue drain on reconnect) are pure client-side Zustand /
// NetInfo behavior with no RPC surface, so — like Batch D's client-only
// fixes — they are covered by the existing unit suite (stores/market.ts,
// stores/moderation.ts, stores/supportChat.ts) rather than here.
import {
    createTestUser,
    createTestBusiness,
    adminClient,
} from './helpers';
import { randomUUID } from 'crypto';

async function getKpis(client: ReturnType<typeof adminClient>, businessId: string) {
    const { data, error } = await client.rpc('get_dashboard_kpis', { p_business_id: businessId });
    expect(error).toBeNull();
    return data as { sales_today: number; revenue_today: number };
}

describe('fix #5 — get_dashboard_kpis counts credit sales today (migration_v219)', () => {
    it('counts a credit (carnet) sale dated today in sales_today, but not in revenue_today', async () => {
        const { client, userId } = await createTestUser('admin');
        const businessId = await createTestBusiness(client, 'Boutique Test');

        // A carnet credit debt — status='credit', is_credit=true, sale_date=CURRENT_DATE.
        const { error: debtErr } = await client.rpc('submit_carnet_debt', {
            p_business_id: businessId,
            p_seller_id: userId,
            p_customer_name: 'Fatoumata',
            p_amount: 500000,
        });
        expect(debtErr).toBeNull();

        const creditOnly = await getKpis(client, businessId);
        expect(creditOnly.sales_today).toBe(1);
        // Credit sales never contribute cash revenue.
        expect(creditOnly.revenue_today).toBe(0);
    });

    it('adds paye and credit sales together for sales_today, keeping revenue cash-only', async () => {
        const { client, userId } = await createTestUser('admin');
        const businessId = await createTestBusiness(client, 'Boutique Test');

        await client.rpc('submit_carnet_debt', {
            p_business_id: businessId, p_seller_id: userId, p_customer_name: 'Awa', p_amount: 400000,
        });
        await client.rpc('submit_quick_sale', {
            p_business_id: businessId, p_seller_id: userId, p_unit_price: 200000,
        });

        const kpis = await getKpis(client, businessId);
        expect(kpis.sales_today).toBe(2);
        // revenue_today only counts the non-credit quick sale.
        expect(kpis.revenue_today).toBe(200000);
    });

    it('excludes an annulée sale from both sales_today and revenue_today', async () => {
        const { client, userId } = await createTestUser('admin');
        const businessId = await createTestBusiness(client, 'Boutique Test');

        const { data: cancelledSaleId } = await client.rpc('submit_quick_sale', {
            p_business_id: businessId, p_seller_id: userId, p_unit_price: 300000,
        });
        expect(cancelledSaleId).toBeTruthy();

        const { error: cancelErr } = await client.rpc('cancel_sale', {
            p_sale_id: cancelledSaleId,
            p_business_id: businessId,
            p_reason: 'Erreur test',
        });
        expect(cancelErr).toBeNull();

        const kpis = await getKpis(client, businessId);
        expect(kpis.sales_today).toBe(0);
        expect(kpis.revenue_today).toBe(0);
    });
});

describe('fix #3 — remove_partnership cascades to DM room + messages (migration_v219)', () => {
    it('deleting a partnership removes its chat_rooms and chat_messages rows', async () => {
        const { client: clientA, userId: userA } = await createTestUser('boutique-a');
        const { client: clientB, userId: userB } = await createTestUser('boutique-b');
        const admin = adminClient();

        const businessA = await createTestBusiness(clientA, 'Boutique A');
        const businessB = await createTestBusiness(clientB, 'Boutique B');

        // A issues an invite code, B sends the request, A accepts.
        const { data: code } = await clientA.rpc('get_or_create_invite_code', {
            p_business_id: businessA,
        });
        expect(code).toBeTruthy();

        const { data: partnershipId } = await clientB.rpc('send_partnership_request', {
            p_invite_code: code,
            p_my_business_id: businessB,
        });
        expect(partnershipId).toBeTruthy();

        const { error: acceptErr } = await clientA.rpc('accept_partnership_request', {
            p_partnership_id: partnershipId,
            p_my_business_id: businessA,
        });
        expect(acceptErr).toBeNull();

        // Lazily create the DM room, then drop one message into it (service role
        // bypasses the admin/manager INSERT gate).
        const { data: roomId } = await clientA.rpc('get_or_create_dm_room', {
            p_partnership_id: partnershipId,
            p_my_business_id: businessA,
        });
        expect(roomId).toBeTruthy();

        const { error: insertErr } = await admin.from('chat_messages').insert({
            room_id: roomId,
            sender_id: userA,
            sender_name: 'Boutique A',
            content: 'Salut partenaire',
        });
        expect(insertErr).toBeNull();

        // Sanity: room + message exist before the unfriend.
        const { data: roomBefore } = await admin.from('chat_rooms').select('id').eq('id', roomId);
        expect(roomBefore).toHaveLength(1);
        const { data: msgBefore } = await admin.from('chat_messages').select('id').eq('room_id', roomId);
        expect(msgBefore).toHaveLength(1);

        // Unfriend — the partnership DELETE must cascade through both FKs.
        const { error: removeErr } = await clientB.rpc('remove_partnership', {
            p_partnership_id: partnershipId,
            p_my_business_id: businessB,
        });
        expect(removeErr).toBeNull();

        const { data: roomAfter } = await admin.from('chat_rooms').select('id').eq('id', roomId);
        expect(roomAfter).toHaveLength(0);
        const { data: msgAfter } = await admin.from('chat_messages').select('id').eq('room_id', roomId);
        expect(msgAfter).toHaveLength(0);
    });
});
