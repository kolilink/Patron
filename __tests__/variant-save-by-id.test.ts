// Bic, 2026-10-16: a product added with models (Rouge 1000 @ 1 500, Bleu 500 @ 1 000) landed with
// NO models and stock 0, while the sheet celebrated. Root cause: handleAdd re-found the created
// product BY NAME to attach the models; when the lookup missed, the whole models save was skipped
// in silence — no call, no alert, no draft. These tests pin the fix: models attach by the id
// createProduct returns, a failed models save is always announced, and the sheet parks the entry
// as an edit draft on the created product instead of resetting it away.

import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

// ── Behavioral: the createProduct id contract (same mocked-outbox harness as quick-add-product) ──
const enqueued: { op: string; payload: any }[] = [];
const mockEnqueue = { fail: false };

jest.mock('@/lib/db', () => ({
  ...jest.requireActual('@/lib/db'),
  enqueue: async (op: string, payload: any) => {
    if (mockEnqueue.fail) throw new Error('disk full');
    enqueued.push({ op, payload });
  },
  getAllQueueItemsForOverlay: async () => ({
    ok: enqueued.map((q, i) => ({ id: i + 1, operation: q.op, payload: JSON.stringify(q.payload), status: 'pending', entity_type: 'produit' })),
    corrupt: [],
  }),
  getProductCache: async () => [],
  getQueueCount: async () => enqueued.length,
}));
jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: async () => { throw new Error('network down'); },
    from: () => { throw new Error('network down'); },
    auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })) },
  },
}));
jest.mock('@/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/lib/posthog', () => ({ posthog: null }));
jest.mock('@/src/utils/notifications', () => ({ notifyEvent: jest.fn(), resolveSellerDisplayName: jest.fn() }));

import { useProductStore } from '@/stores/products';

describe('createProduct id contract', () => {
  beforeEach(() => { enqueued.length = 0; mockEnqueue.fail = false; });

  it('returns the caller-provided id verbatim — the id follow-up writes attach to', async () => {
    const id = await useProductStore.getState().createProduct('biz', 'user', {
      id: 'prod-fixed-id', name: 'Bic', unit: 'pcs', cost_price: 0, sale_price: 1000, reorder_level: 0, initial_stock: 0,
    });
    expect(id).toBe('prod-fixed-id');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].payload.product.id).toBe('prod-fixed-id');
  });

  it('returns the generated id — the same id the outbox row carries', async () => {
    const id = await useProductStore.getState().createProduct('biz', 'user', {
      name: 'Bic', unit: 'pcs', cost_price: 0, sale_price: 1000, reorder_level: 0, initial_stock: 0,
    });
    expect(id).toBe(enqueued[0].payload.product.id);
  });

  it('returns null when the local write fails — never a truthy id for a product that does not exist', async () => {
    mockEnqueue.fail = true;
    const id = await useProductStore.getState().createProduct('biz', 'user', {
      name: 'Bic', unit: 'pcs', cost_price: 0, sale_price: 1000, reorder_level: 0, initial_stock: 0,
    });
    expect(id).toBeNull();
    expect(enqueued).toHaveLength(0);
  });
});

// ── Source contracts: the add path can never skip the models save silently again ──
const handleAddBody = () => {
  const src = read('src/components/products/useProductSheets.tsx');
  return src.slice(src.indexOf('const handleAdd'), src.indexOf('const handleEdit'));
};

describe('variant save by id — source contracts', () => {
  it('createProduct is typed to return the id (string | null), and its body does', () => {
    const store = read('stores/products.ts');
    expect(store).toContain('createProduct: (businessId: string, userId: string, data: CreateProductData) => Promise<string | null>');
    const impl = store.slice(store.indexOf('createProduct: async'), store.indexOf('updateProduct: async'));
    expect(impl).toContain('return productId;');
    expect(impl).toContain('return null;');
    expect(impl).not.toContain('return true;');
  });

  it('handleAdd attaches the models by the returned id — the name lookup is gone', () => {
    const body = handleAddBody();
    expect(body).toContain('const createdId = await createProduct(businessId, userId, data)');
    expect(body).toContain('upsertVariants(businessId, createdId, userId, variants)');
    expect(body).not.toContain('.find(');
    expect(body).not.toContain('nameLower');
  });

  it('a failed models save is announced AND returned as modelsPending with the created id', () => {
    const body = handleAddBody();
    const failBlock = body.slice(body.indexOf('if (!variantsOk) {'));
    expect(failBlock).toContain('modelsNotSavedAlert()');
    expect(failBlock).toContain('return { ok: true, modelsPending: true, createdProductId: createdId };');
  });

  it('the offline case takes the same announced path (isKnownOffline short-circuit kept)', () => {
    expect(handleAddBody()).toContain('isKnownOffline() ? false : await upsertVariants');
  });

  it('the sheet parks a modelsPending add as an edit draft on the created product, retires the add draft, and never celebrates it', () => {
    const sheet = read('src/components/QuickAddProductSheet.tsx');
    const submit = sheet.slice(sheet.indexOf('const submit = async'), sheet.indexOf('const collapsedName'));
    expect(submit).toContain('if (res.modelsPending && res.createdProductId) {');
    const branch = submit.slice(submit.indexOf('if (res.modelsPending'));
    expect(branch).toContain('saveQuickAddDraft(businessId, editDraftId(res.createdProductId), sRef.current, { productId: res.createdProductId })');
    expect(branch).toContain('removeQuickAddDraft(businessId, draftId.current)');
    expect(branch).toContain('onClose();');
    // …and the branch runs BEFORE the celebration: the name toast / rapid-loop reset come after it.
    expect(submit.indexOf('if (res.modelsPending')).toBeLessThan(submit.indexOf('showToast(name)'));
  });

  it('the other createProduct callers read the id return as success/failure explicitly', () => {
    expect(read('app/(app)/fournisseurs/index.tsx')).toContain('const ok = (await createProduct(businessId, userId, { ...payload.data, id: productId })) != null;');
    expect(read('app/(app)/fournisseurs/reception.tsx')).toContain('const ok = (await createProduct(businessId, userId, { ...payload.data, id: productId })) != null;');
  });
});
