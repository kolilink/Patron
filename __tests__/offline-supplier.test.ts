// Offline supplier creation via the outbox (migration_v244): a supplier
// created in a dead zone is written local-first into the durable queue,
// appears on screen immediately (marked pending), and drains through
// upsert_supplier with the SAME client-generated UUID — never re-keyed.
//
// Covers the five locked tests:
//   1. offline create → drain → same UUID reaches the server
//   2. drain ordering: create_supplier before a confirm_reception that
//      references it (no dangling ref)
//   3. retry dedupe: the supplier id IS the idempotency key, and the server
//      upsert is ON CONFLICT (id) DO NOTHING
//   4. offline edit of a still-pending create amends the queued payload
//      (exactly one row), never enqueues a second op
//   5. the validation gate refuses a malformed create_supplier payload

const mockQueue: any[] = [];
let mockNextId = 1;
let conn = { online: false, known: true };
let rpcError: any = null;
const rpcCalls: { fn: string; args: any }[] = [];

const entityTypeFor = (operation: string): string => {
    if (operation === 'create_supplier' || operation === 'update_supplier') return 'fournisseur';
    if (operation === 'confirm_reception') return 'reception';
    return operation;
};
const idempotencyKeyFor = (operation: string, payload: any): string | null => {
    if (operation === 'create_supplier' || operation === 'update_supplier') return payload.p_supplier?.id ?? null;
    if (operation === 'confirm_reception') return payload.p_idempotency_key ?? null;
    return null;
};

jest.mock('@/lib/connectivity', () => ({
    isKnownOffline: () => conn.known && !conn.online,
}));

jest.mock('@/lib/db', () => ({
    enqueue: async (operation: string, payload: any) => {
        mockQueue.push({
            id: mockNextId++, operation, payload: JSON.stringify(payload), status: 'pending', attempts: 0, last_error: null,
            next_attempt_at: '2000-01-01T00:00:00.000Z', queued_at: new Date().toISOString(), created_at: new Date().toISOString(),
            entity_type: entityTypeFor(operation), idempotency_key: idempotencyKeyFor(operation, payload),
        });
    },
    amendPendingQueueItem: async (operation: string, key: string, payload: any) => {
        let changes = 0;
        for (const q of mockQueue) {
            if (q.status === 'pending' && q.operation === operation && q.idempotency_key === key) {
                q.payload = JSON.stringify(payload); changes++;
            }
        }
        return changes;
    },
    getAllQueueItemsForOverlay: async () => ({ ok: mockQueue.map(q => ({ ...q })), corrupt: [] }),
    getPendingOpsForDrain: async () => ({
        ok: mockQueue.filter(q => q.status === 'pending' && (!q.next_attempt_at || q.next_attempt_at <= new Date().toISOString())).map(q => ({ ...q })),
        corrupt: [],
    }),
    deleteQueueItem: async (id: number) => { const i = mockQueue.findIndex(q => q.id === id); if (i >= 0) mockQueue.splice(i, 1); },
    rescheduleOp: async (id: number, nextAttemptAt: string, error: string) => {
        const q = mockQueue.find(x => x.id === id);
        if (q) { q.attempts++; q.next_attempt_at = nextAttemptAt; q.last_error = error; }
    },
    markOpPermanentlyFailed: async (id: number, e: string) => { const q = mockQueue.find(x => x.id === id); if (q) { q.status = 'failed_permanent'; q.last_error = e; } },
    markOpCorrupt: async (id: number, e: string) => { const q = mockQueue.find(x => x.id === id); if (q) { q.status = 'failed_corrupt'; q.last_error = e; } },
    getPendingSupplierKeys: async () => new Set(
        mockQueue.filter(q => q.status === 'pending' && q.operation === 'create_supplier').map(q => q.idempotency_key).filter((k: unknown): k is string => typeof k === 'string'),
    ),
    getQueueCount: async () => mockQueue.filter(q => q.status === 'pending').length,
    getFailedQueueCount: async () => 0,
    getFournisseurCache: async () => null,
    saveFournisseurCache: async () => { },
    getCommandeCache: async () => null,
    saveCommandeCache: async () => { },
    getCacheTimestamp: async () => null,
    getProductCache: async () => null,
    saveProductCache: async () => { },
    getVariantsCache: async () => null,
    saveVariantsCache: async () => { },
    getClientLedgerCache: async () => null,
    saveClientLedgerCache: async () => { },
}));

jest.mock('@/lib/supabase', () => ({
    supabase: {
        rpc: async (fn: string, args: any) => {
            rpcCalls.push({ fn, args });
            return { data: null, error: rpcError };
        },
        from: () => ({
            insert: async () => ({ data: null, error: null }),
            update: () => ({ in: async () => ({ data: null, error: null }), eq: async () => ({ data: null, error: null }) }),
            select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
            delete: () => ({ eq: () => ({ eq: async () => ({ data: null, error: null }) }) }),
        }),
        auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })) },
    },
}));
jest.mock('@/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/lib/posthog', () => ({ posthog: null }));
jest.mock('@/src/utils/notifications', () => ({ notifyEvent: jest.fn(), resolveSellerDisplayName: jest.fn().mockResolvedValue('Fatou') }));
jest.mock('@/stores/auth', () => ({
    useAuthStore: { getState: () => ({ session: { activeBusiness: { id: 'biz-1' }, activeMembership: { role: 'administrateur' }, user: { id: 'u1' } } }) },
}));

import { useFournisseursStore } from '@/stores/fournisseurs';
import { useSyncStore } from '@/stores/sync';
import { drainQueue } from '@/lib/sync';
import { enqueue } from '@/lib/db';
import { validateOutboxPayload, OutboxValidationError } from '@/lib/outboxValidation';

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SUP = U(1);
const createPayload = (name = 'Diallo Import') => ({
    p_supplier: { id: SUP, business_id: 'biz-1', name, phone: null, country: null, notes: null, lead_days: null, created_by: 'u1' },
    p_new_products: [], p_link_product_ids: [], p_unlink_product_ids: [],
});
const receptionPayload = () => ({
    p_business_id: 'biz-1', p_supplier_id: SUP, p_po_id: null,
    p_lines: [{ product_id: 'p1', variant_id: null, name: 'Riz', qty: 1, unit_cost_cents: 100, sale_price_cents: null }],
    p_transport_cost_cents: 0, p_margin_percent: null, p_received_date: null, p_idempotency_key: 'po-1',
});

beforeEach(() => {
    mockQueue.length = 0; mockNextId = 1; rpcCalls.length = 0; rpcError = null;
    conn = { online: false, known: true };
    useFournisseursStore.setState({ fournisseurs: [], saving: false, error: null });
    useSyncStore.setState({ pendingCount: 0, kick: jest.fn() } as any);
});

describe('offline create → drain → same UUID', () => {
    it('writes one create_supplier, shows the pending supplier immediately, and drains the SAME id to upsert_supplier', async () => {
        const id = await useFournisseursStore.getState().createFournisseur('biz-1', 'u1', {
            name: 'Diallo Import', phone: '+224 620 00 00 00', linkedProductIds: ['p1'],
        });
        expect(id).toBeTruthy();

        expect(mockQueue).toHaveLength(1);
        expect(mockQueue[0].operation).toBe('create_supplier');
        expect(mockQueue[0].idempotency_key).toBe(id);

        const pending = useFournisseursStore.getState().fournisseurs.find(f => f.id === id);
        expect(pending).toBeTruthy();
        expect(pending!._pending).toBe(true);
        expect(pending!.name).toBe('Diallo Import');

        // Still offline: the drain must not even attempt.
        expect(await drainQueue()).toMatchObject({ synced: 0 });
        expect(rpcCalls).toHaveLength(0);
        expect(mockQueue).toHaveLength(1);

        // Reconnect: one drain → one upsert_supplier call carrying the same UUID.
        conn = { online: true, known: true };
        const r = await drainQueue();
        expect(r.synced).toBe(1);
        expect(mockQueue).toHaveLength(0);
        const call = rpcCalls.find(c => c.fn === 'upsert_supplier');
        expect(call).toBeTruthy();
        expect(call!.args.p_supplier.id).toBe(id);
        expect(call!.args.p_is_edit).toBe(false);
    });
});

describe('drain ordering', () => {
    it('holds a confirm_reception whose supplier create is still queued (no dangling ref)', async () => {
        await enqueue('create_supplier', createPayload());
        await enqueue('confirm_reception', receptionPayload());

        // The create fails with a 5xx-shaped, non-network, non-P0001 error: it
        // reschedules AND continues (the FIFO hole), so the reception is reached
        // in the same pass and must be held — not sent into resolve_reception_supplier.
        rpcError = { code: '500', message: 'Internal Server Error' };
        conn = { online: true, known: true };
        const r = await drainQueue();

        expect(r.synced).toBe(0);
        expect(r.failed).toBe(2);                              // create failed + reception held
        expect(rpcCalls.map(c => c.fn)).toEqual(['upsert_supplier']); // the reception never reached the server
        expect(mockQueue.map(q => q.operation).sort()).toEqual(['confirm_reception', 'create_supplier']);
        expect(mockQueue.every(q => q.status === 'pending')).toBe(true);
        const reception = mockQueue.find(q => q.operation === 'confirm_reception');
        expect(reception!.attempts).toBe(1);
        expect(reception!.last_error).toMatch(/Création du fournisseur encore en attente/);
    });

    it('a create_supplier that succeeds in the same pass clears the hold for a later pass', async () => {
        await enqueue('create_supplier', createPayload());
        await enqueue('confirm_reception', receptionPayload());

        conn = { online: true, known: true };
        const first = await drainQueue();
        // The create drains first (FIFO), deleting its pending key; the reception
        // drains next in the SAME pass because the key is gone by then.
        expect(first.synced).toBe(2);
        expect(mockQueue).toHaveLength(0);
        expect(rpcCalls.filter(c => c.fn !== 'log_sync_lag').map(c => c.fn)).toEqual(['upsert_supplier', 'confirm_reception']);
    });
});

describe('retry dedupe', () => {
    it('the supplier id is the idempotency key, and the server upsert is ON CONFLICT (id) DO NOTHING', () => {
        const fs = require('fs'); const path = require('path');
        const sql = fs.readFileSync(path.resolve(__dirname, '..', 'db/migration_v244.sql'), 'utf8');
        expect(sql).toMatch(/ON CONFLICT \(id\) DO NOTHING/);
        const db = fs.readFileSync(path.resolve(__dirname, '..', 'lib/db.ts'), 'utf8');
        expect(db).toMatch(/operation === 'create_supplier' \|\| operation === 'update_supplier'/);
        expect(db).toMatch(/p_supplier/);
    });

    it('two same-id enqueues carry one idempotency key, so the server dedupes the replay', async () => {
        await enqueue('create_supplier', createPayload());
        await enqueue('create_supplier', createPayload());
        expect(mockQueue).toHaveLength(2);
        expect(new Set(mockQueue.map(q => q.idempotency_key)).size).toBe(1);
        expect(mockQueue[0].idempotency_key).toBe(SUP);
    });
});

describe('offline edit of a pending supplier amends the queued payload', () => {
    it('exactly one row remains, still a create_supplier, carrying the edited name', async () => {
        const id = await useFournisseursStore.getState().createFournisseur('biz-1', 'u1', { name: 'Diallo Import' });
        expect(mockQueue).toHaveLength(1);

        const ok = await useFournisseursStore.getState().updateFournisseur(id!, 'biz-1', 'u1', {
            name: 'Diallo Import Édité', linkedProductIds: [], unlinkedProductIds: [],
        });
        expect(ok).toBe(true);
        expect(mockQueue).toHaveLength(1);                     // never a second op
        expect(mockQueue[0].operation).toBe('create_supplier');
        expect(JSON.parse(mockQueue[0].payload).p_supplier.name).toBe('Diallo Import Édité');
    });
});

describe('validation gate', () => {
    it('refuses a malformed create_supplier payload before any write', () => {
        expect(() => validateOutboxPayload('create_supplier', { p_supplier: { id: 'not-a-uuid', name: '  ' } }))
            .toThrow(OutboxValidationError);
    });
});
