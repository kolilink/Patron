// Every tap answers: a rapid double-tap on a slow connection must execute
// exactly once. Covers the guard primitive and the four guarded actions
// (réception confirm, product archive, supplier deletion, team revoke) at the
// store level — the layer that actually fires the request.

let release: () => void = () => {};
let pending: Promise<void> = Promise.resolve();
const calls = { update: 0, delete: 0, rpc: 0 };
const gate = () => { pending = new Promise<void>(r => { release = r; }); };

function chain(result: unknown) {
  const b: any = new Proxy({}, {
    get: (_t, prop) => (prop === 'then'
      ? (res: any, rej: any) => pending.then(() => result).then(res, rej)
      : () => b),
  });
  return b;
}

jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({
      update: () => { calls.update++; return chain({ error: null }); },
      delete: () => { calls.delete++; return chain({ error: null }); },
      select: () => chain({ data: [], error: null }),
    }),
    rpc: () => { calls.rpc++; return chain({ data: 'po-1', error: null }); },
    auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })) },
  },
}));
const outbox: any[] = [];
jest.mock('@/lib/db', () => ({
  ...jest.requireActual('@/lib/db'),
  enqueue: jest.fn(async (operation: string, payload: any) => { outbox.push({ operation, idempotency_key: payload.p_idempotency_key }); }),
  getAllQueueItemsForOverlay: async () => ({ ok: outbox.map(o => ({ ...o })), corrupt: [] }),
  getQueueCount: jest.fn(async () => outbox.length),
  getProductCache: jest.fn().mockResolvedValue(null),
  saveProductCache: jest.fn(),
}));
jest.mock('@/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/lib/posthog', () => ({ posthog: null }));
jest.mock('@/stores/sync', () => ({ useSyncStore: { getState: () => ({ kick: jest.fn() }), setState: jest.fn() } }));
jest.mock('@/src/utils/notifications', () => ({ notifyEvent: jest.fn() }));
jest.mock('@/stores/auth', () => ({
  useAuthStore: { getState: () => ({ session: { activeMembership: { role: 'administrateur' }, activeBusiness: { id: 'biz-1' }, user: { id: 'u1' } } }) },
}));

import { createInflightGuard, createKeyedInflightGuard } from '@/lib/inflight';
import { useProductStore } from '@/stores/products';
import { useFournisseursStore } from '@/stores/fournisseurs';
import { useEquipeStore } from '@/stores/equipe';

beforeEach(() => {
  calls.update = 0; calls.delete = 0; calls.rpc = 0;
  gate();
});

describe('guard primitive', () => {
  it('swallows a second call while the first is pending, then allows the next', async () => {
    const guard = createInflightGuard();
    let runs = 0;
    let done!: () => void;
    const first = guard.run(async () => { runs++; await new Promise<void>(r => { done = r; }); return 'a'; });
    const second = await guard.run(async () => { runs++; return 'b'; });
    expect(second).toEqual({ ran: false });
    expect(guard.busy).toBe(true);
    done();
    expect(await first).toEqual({ ran: true, value: 'a' });
    expect(guard.busy).toBe(false);
    expect(await guard.run(async () => 'c')).toEqual({ ran: true, value: 'c' });
    expect(runs).toBe(1);
  });
  it('releases even when the action throws, so the control is never stuck', async () => {
    const guard = createInflightGuard();
    await expect(guard.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(guard.busy).toBe(false);
    expect(await guard.run(async () => 1)).toEqual({ ran: true, value: 1 });
  });
  it('keyed: same key once, different keys in parallel', async () => {
    const g = createKeyedInflightGuard();
    let done!: () => void;
    const a1 = g.run('a', () => new Promise<void>(r => { done = r; }));
    expect(await g.run('a', async () => undefined)).toEqual({ ran: false });
    expect((await g.run('b', async () => 1)).ran).toBe(true);
    done(); await a1;
    expect(g.isBusy('a')).toBe(false);
  });
});

describe('double-tap → exactly one execution', () => {
  it('product archive', async () => {
    const { archiveProduct } = useProductStore.getState();
    const p1 = archiveProduct('prod-1', 'biz-1');
    const p2 = archiveProduct('prod-1', 'biz-1');
    expect(useProductStore.getState().archivingIds).toEqual(['prod-1']); // the row can show "Désactivation…" at once
    release();
    await Promise.all([p1, p2]);
    expect(calls.update).toBe(1);
    expect(useProductStore.getState().archivingIds).toEqual([]);
  });

  it('product archive: a different product is not blocked by the first', async () => {
    const { archiveProduct } = useProductStore.getState();
    const a = archiveProduct('prod-1', 'biz-1');
    const b = archiveProduct('prod-2', 'biz-1');
    expect(useProductStore.getState().archivingIds.sort()).toEqual(['prod-1', 'prod-2']);
    release();
    await Promise.all([a, b]);
    expect(calls.update).toBe(2);
  });

  it('supplier deletion', async () => {
    const { deleteFournisseur } = useFournisseursStore.getState();
    const a = deleteFournisseur('sup-1', 'biz-1');
    const b = deleteFournisseur('sup-1', 'biz-1');
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(calls.delete).toBe(1);
    expect(ra.ok).toBe(true);
    expect(rb).toEqual({ ok: false, message: null }); // swallowed, no error invented
  });

  it('team revoke', async () => {
    useEquipeStore.setState({ membres: [{ id: 'm1', business_id: 'biz-1', user_id: 'u2' } as any] });
    const { removeMembre } = useEquipeStore.getState();
    const a = removeMembre('m1');
    const b = removeMembre('m1');
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(calls.delete).toBe(1);
    expect(ra).toBe(true);
    expect(rb).toBe(false);
  });

  it('réception confirm (a money record) books once', async () => {
    useFournisseursStore.setState({
      fetchCommandes: async () => {}, fetchFournisseurs: async () => {},
    } as any);
    const { confirmReception } = useFournisseursStore.getState();
    const input = { supplierId: null, lines: [{ product_id: 'p1', variant_id: null, name: 'Riz', qty: 2, unit_cost_cents: 100, sale_price_cents: 150 }], transportCostCents: 0, marginPercent: null, receivedDate: null } as any;
    outbox.length = 0;
    const a = confirmReception('biz-1', 'u1', { ...input, idempotencyKey: 'key-dbl' });
    const b = confirmReception('biz-1', 'u1', { ...input, idempotencyKey: 'key-dbl' });
    release();
    const [ra, rb] = await Promise.all([a, b]);
    // A réception is queued, not sent: one outbox row, and the direct RPC is never called from the tap.
    expect(outbox.filter(o => o.operation === 'confirm_reception')).toHaveLength(1);
    expect(calls.rpc).toBe(0);
    expect(ra).toBe('key-dbl');
    expect(rb).toBeNull();
  });
});

describe('screens wire the guard to the tapped control', () => {
  const fs = require('fs'); const path = require('path');
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
  it('réception: confirm runs through useInFlight and the button shows its status word', () => {
    const src = read('app/(app)/fournisseurs/reception.tsx');
    expect(src).toMatch(/const \[confirming, runConfirm\] = useInFlight\(\)/);
    expect(src).toMatch(/saving=\{saving \|\| confirming\}/);
    expect(src).toMatch(/loadingLabel="Enregistrement"/);
  });
  it('archive: the product row shows "Désactivation" and is disabled', () => {
    const src = read('app/(app)/(tabs)/catalogue.tsx');
    expect(src).toMatch(/word="Désactivation"/);
    expect(src).toMatch(/disabled=\{archiving\}/);
  });
  it('supplier deletion: the header control shows "Suppression" and is disabled', () => {
    const src = read('app/(app)/fournisseurs/[id].tsx');
    expect(src).toMatch(/runDelete\(async/);
    expect(src).toMatch(/word="Suppression"/);
    expect(src).toMatch(/disabled=\{deleting\}/);
  });
  it('team revoke: "Retirer" shows its status and is disabled', () => {
    const src = read('app/(app)/equipe/index.tsx');
    expect(src).toMatch(/runRemove\(async/);
    expect(src).toMatch(/word="Retrait"/);
    expect(src).toMatch(/onPress=\{handleRemove\} disabled=\{removing\}/);
  });
});
