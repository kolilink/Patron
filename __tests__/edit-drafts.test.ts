// Interrupted edits join "À compléter": one edit draft per product, local only.
import * as fs from 'fs';
import * as path from 'path';
import { EMPTY_QUICK_ADD, editingToState, isEditDirty, type QuickAddState } from '@/src/utils/quickAddProduct';

const read = (f: string) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const st = (over: Partial<QuickAddState> = {}): QuickAddState => ({ ...EMPTY_QUICK_ADD, ...over });
const product = { id: 'p1', name: 'Riz', sale_price: 1500, cost_price: 1000, stock_qty: 8, has_variants: false, supplier_id: null } as any;
const saved = editingToState(product, [], 'GNF');

describe('isEditDirty', () => {
  it('a freshly loaded edit is clean', () => expect(isEditDirty(saved, editingToState(product, [], 'GNF'))).toBe(false));
  it('whitespace-only changes are clean', () => expect(isEditDirty({ ...saved, name: ' Riz ' }, saved)).toBe(false));
  it('name / price / cost / supplier / models changes are dirty', () => {
    expect(isEditDirty({ ...saved, name: 'Riz 5kg' }, saved)).toBe(true);
    expect(isEditDirty({ ...saved, price: '2 000' }, saved)).toBe(true);
    expect(isEditDirty({ ...saved, purchasePrice: '900' }, saved)).toBe(true);
    expect(isEditDirty({ ...saved, supplierId: 's1' }, saved)).toBe(true);
    expect(isEditDirty({ ...saved, models: true }, saved)).toBe(true);
  });
  it('quantity alone is not an edit (stock only changes through Ajuster)', () => {
    expect(isEditDirty({ ...saved, qty: '99' }, saved)).toBe(false);
  });
});

describe('edit drafts in the À compléter pool', () => {
  const store: Record<string, string> = {};
  const outbox: any[] = [];
  const load = () => {
    jest.resetModules();
    jest.doMock('@/lib/db', () => ({
      getKV: async (k: string) => store[k] ?? null,
      setKV: async (k: string, v: string) => { store[k] = v; },
      enqueue: async (...a: any[]) => { outbox.push(a); },
    }));
    return require('@/lib/quickAddDraft') as typeof import('@/lib/quickAddDraft');
  };
  beforeEach(() => { Object.keys(store).forEach(k => delete store[k]); outbox.length = 0; });

  it('saves an edit draft carrying kind and productId, and restores the state as typed', async () => {
    const d = load();
    await d.saveQuickAddDraft('biz', d.editDraftId('p1'), { ...saved, price: '2 000' }, { productId: 'p1' });
    const [got] = await d.listQuickAddDrafts('biz');
    expect(got).toMatchObject({ id: 'edit-p1', kind: 'edit', productId: 'p1' });
    expect(got.state.price).toBe('2 000');
  });

  it('a second edit of the same product upserts — still one draft', async () => {
    const d = load();
    await d.saveQuickAddDraft('biz', d.editDraftId('p1'), { ...saved, price: '2 000' }, { productId: 'p1' });
    await d.saveQuickAddDraft('biz', d.editDraftId('p1'), { ...saved, price: '2 500' }, { productId: 'p1' });
    const list = await d.listQuickAddDrafts('biz');
    expect(list).toHaveLength(1);
    expect(list[0].state.price).toBe('2 500');
  });

  it('shares the max-3 newest-first pool with add drafts; add drafts are unaffected', async () => {
    const d = load();
    await d.saveQuickAddDraft('biz', 'a', st({ name: 'Huile' }));
    await d.saveQuickAddDraft('biz', d.editDraftId('p1'), { ...saved, price: '2 000' }, { productId: 'p1' });
    let list = await d.listQuickAddDrafts('biz');
    expect(list.map(x => x.kind ?? 'add').sort()).toEqual(['add', 'edit']);
    expect(list.find(x => x.id === 'a')!.kind).toBeUndefined();
    await d.saveQuickAddDraft('biz', 'b', st({ name: 'Sucre' }));
    await d.saveQuickAddDraft('biz', 'c', st({ name: 'Sel' }));
    list = await d.listQuickAddDrafts('biz');
    expect(list).toHaveLength(3);
    expect(list.some(x => x.id === 'edit-p1')).toBe(true); // newer than 'a', which was pushed out
    expect(list.some(x => x.id === 'a')).toBe(false);
  });

  it('an edit draft is kept even when every field was cleared (it is a diff, not a blank add)', async () => {
    const d = load();
    await d.saveQuickAddDraft('biz', d.editDraftId('p1'), st({ name: '' }), { productId: 'p1' });
    expect(await d.listQuickAddDrafts('biz')).toHaveLength(1);
  });

  it('Enregistrer / × remove it; nothing is ever enqueued', async () => {
    const d = load();
    await d.saveQuickAddDraft('biz', d.editDraftId('p1'), { ...saved, price: '2 000' }, { productId: 'p1' });
    await d.removeQuickAddDraft('biz', d.editDraftId('p1'));
    expect(await d.listQuickAddDrafts('biz')).toEqual([]);
    expect(outbox).toHaveLength(0);
  });
});

describe('wiring (source-level: no component-render harness in this repo)', () => {
  const sheet = read('src/components/QuickAddProductSheet.tsx');
  const hook = read('src/components/products/useProductSheets.tsx');
  const manager = read('src/components/products/ProductManager.tsx');

  it('edit: debounced 400ms autosave keyed by product id, only when dirty', () => {
    expect(sheet).toMatch(/isEditDirty\(s, editingToState\(editing, initialVariants \?\? \[\], currency\)\)/);
    expect(sheet).toMatch(/saveQuickAddDraft\(businessId, editDraftId\(productId\), s, \{ productId \}\)[\s\S]*?\}, 400\)/);
  });
  it('dismiss flushes a dirty edit; a clean dismiss saves nothing', () => {
    expect(sheet).toMatch(/if \(isEdit && editing && editDirtyRef\.current && !editSubmitted\.current\) \{[\s\S]*?saveQuickAddDraft\(/);
    expect(sheet).not.toMatch(/if \(isEdit && editing && !editDirtyRef/);
  });
  it('Enregistrer removes the edit draft and blocks any later autosave', () => {
    expect(sheet).toMatch(/if \(isEdit && editing\) \{\s*\n\s*editSubmitted\.current = true;[\s\S]*?removeQuickAddDraft\(businessId, editDraftId\(editing\.id\)\)/);
  });
  it('supplier / delivery contexts and add mode keep their own rules (no edit draft code path there)', () => {
    expect(sheet).toContain('const noDraft = isEdit || isDelivery;');
    expect(sheet).toMatch(/if \(!visible \|\| !isEdit \|\| !editing \|\| editSubmitted\.current\) return;/);
  });
  it('tapping an edit draft reopens that product in edit mode with the draft restored', () => {
    expect(hook).toMatch(/d\.kind === 'edit'[\s\S]*?setResumeEdit\(d\); setEditTarget\(product\)[\s\S]*?setEditOpen\(true\)/);
    expect(hook).toContain('resumeEditDraft={resumeEdit}');
    expect(sheet).toMatch(/setS\(resumeEdit \? resumeEdit\.state : editingToState\(/);
  });
  it('"À compléter" shows the product name + "Modifications non enregistrées" for edit drafts', () => {
    expect(manager).toContain("d.kind === 'edit' ? 'Modifications non enregistrées'");
  });
});
