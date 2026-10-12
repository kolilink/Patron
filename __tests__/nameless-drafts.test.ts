// A nameless ADD draft is not a draft: it has no row to show and nothing to tap, so it is never
// persisted (and one the session already wrote is removed). Edit drafts always belong to a named
// product and are exempt from the filter.

import fs from 'fs';
import path from 'path';

const store: Record<string, string> = {};
jest.mock('@/lib/db', () => ({
  getKV: async (k: string) => store[k] ?? null,
  setKV: async (k: string, v: string) => { store[k] = v; },
}));

import { EMPTY_QUICK_ADD, isResumableAddDraft, type QuickAddState } from '@/src/utils/quickAddProduct';
import { listQuickAddDrafts, removeQuickAddDraft, saveQuickAddDraft, editDraftId, MAX_DRAFTS } from '@/lib/quickAddDraft';

const st = (over: Partial<QuickAddState> = {}): QuickAddState => ({ ...EMPTY_QUICK_ADD, ...over });
const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');
const KEY = 'quick_add_drafts_biz';

beforeEach(() => { Object.keys(store).forEach(k => delete store[k]); });

describe('nameless add state', () => {
  it('is not resumable; a named one is', () => {
    expect(isResumableAddDraft(st({ price: '1 000' }))).toBe(false);          // a price, no name
    expect(isResumableAddDraft(st({ name: '   ', price: '1 000' }))).toBe(false);
    expect(isResumableAddDraft(st())).toBe(false);                            // blank
    expect(isResumableAddDraft(st({ name: 'Riz' }))).toBe(true);
    expect(isResumableAddDraft(st({ name: 'Riz', price: '1 000' }))).toBe(true);
  });

  it('autosave / dismiss of a nameless state persists NOTHING', async () => {
    await saveQuickAddDraft('biz', 'd1', st({ price: '1 000', qty: '4' }));
    expect(await listQuickAddDrafts('biz')).toEqual([]);
    expect(store[KEY] ?? '').toBe('');
  });

  it('a draft the session already wrote is REMOVED once its name is cleared (not left behind, not overwritten)', async () => {
    await saveQuickAddDraft('biz', 'd1', st({ name: 'Riz', price: '1 000' }));
    expect((await listQuickAddDrafts('biz')).map(d => d.id)).toEqual(['d1']);
    await saveQuickAddDraft('biz', 'd1', st({ name: '', price: '1 000' }));   // she deleted the name
    expect(await listQuickAddDrafts('biz')).toEqual([]);
  });

  it('a named draft is listed and resumable with its state intact', async () => {
    await saveQuickAddDraft('biz', 'd1', st({ name: 'Riz', price: '2 500', qty: '3' }));
    const [d] = await listQuickAddDrafts('biz');
    expect(d.id).toBe('d1');
    expect(d.state).toMatchObject({ name: 'Riz', price: '2 500', qty: '3' });
  });

  it('nameless states never take one of the 3 slots', async () => {
    for (const n of ['A', 'B', 'C']) {
      await saveQuickAddDraft('biz', `d-${n}`, st({ name: n }));
      await new Promise(r => setTimeout(r, 2));
    }
    await saveQuickAddDraft('biz', 'nameless', st({ price: '9' }));
    expect((await listQuickAddDrafts('biz')).map(d => d.state.name).sort()).toEqual(['A', 'B', 'C']);
    expect(MAX_DRAFTS).toBe(3);
  });

  it('a nameless add draft persisted by an older build is dropped when the list is read', async () => {
    store[KEY] = JSON.stringify([
      { id: 'old-nameless', savedAt: 2, state: st({ price: '5 000' }) },
      { id: 'old-named', savedAt: 1, state: st({ name: 'Savon' }) },
    ]);
    expect((await listQuickAddDrafts('biz')).map(d => d.id)).toEqual(['old-named']);
  });
});

describe('edit drafts are unaffected by the name filter', () => {
  it('an edit draft persists whatever its name field holds (it belongs to a named product)', async () => {
    await saveQuickAddDraft('biz', editDraftId('p1'), st({ name: 'Riz', price: '2 000' }), { productId: 'p1' });
    await saveQuickAddDraft('biz', editDraftId('p2'), st({ name: '', price: '2 000' }), { productId: 'p2' }); // name cleared mid-edit
    const ids = (await listQuickAddDrafts('biz')).map(d => d.id).sort();
    expect(ids).toEqual(['edit-p1', 'edit-p2']);
  });
  it('removing an add draft leaves edit drafts alone, and vice versa', async () => {
    await saveQuickAddDraft('biz', 'd1', st({ name: 'Riz' }));
    await saveQuickAddDraft('biz', editDraftId('p1'), st({ name: 'Thé' }), { productId: 'p1' });
    await removeQuickAddDraft('biz', 'd1');
    expect((await listQuickAddDrafts('biz')).map(d => d.id)).toEqual(['edit-p1']);
  });
});

describe('where the rule is enforced', () => {
  it('both the debounced autosave and the on-dismiss save go through saveQuickAddDraft (one rule, in the store)', () => {
    const sheet = read('src/components/QuickAddProductSheet.tsx');
    expect(sheet).toMatch(/void saveQuickAddDraft\(businessId, draftId\.current, s\)/);            // autosave
    expect(sheet).toMatch(/!noDraft && !supplierCtx && !added\.current\) void saveQuickAddDraft\(businessId, draftId\.current, sRef\.current\)/); // dismiss
    expect(sheet).not.toMatch(/setKV/);
    expect(read('lib/quickAddDraft.ts')).toContain('!edit && !isResumableAddDraft(state) ? rest');
  });
  it('the "Sans nom" fallback stays as defence only', () => {
    expect(read('src/components/products/ProductManager.tsx')).toContain("'Sans nom'; // defence only");
  });
});
