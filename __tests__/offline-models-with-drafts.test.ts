// #113 (no silent variant loss offline) × #114 (edit drafts): the two are orthogonal, and this pins
// the places they touch. Drafts live in the device kv_store and never need the network; the sheet
// never calls the online-only models RPC offline; and an edit whose models change could not be saved
// must NOT delete the draft that holds that change.

import fs from 'fs';
import path from 'path';

const store: Record<string, string> = {};
jest.mock('@/lib/db', () => ({
  getKV: async (k: string) => store[k] ?? null,
  setKV: async (k: string, v: string) => { store[k] = v; },
}));

import { EMPTY_QUICK_ADD, editingToState, isEditDirty, patchVariant, addVariant, setModels } from '@/src/utils/quickAddProduct';
import { editDraftId, listQuickAddDrafts, saveQuickAddDraft, removeQuickAddDraft } from '@/lib/quickAddDraft';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const C = 'GNF';

const product = (over: any = {}) => ({
  id: 'prod-1', name: 'T-shirt', cost_price: 1000, sale_price: 5000, stock_qty: 0, reorder_level: 0, unit: 'pcs',
  has_variants: true, archived: false, supplier_id: null, ...over,
}) as any;
const variants = [
  { id: 'v-m', name: 'M', sale_price: 5000, cost_price: 1000, stock_qty: 4 },
  { id: 'v-l', name: 'L', sale_price: 5000, cost_price: 1000, stock_qty: 2 },
] as any[];

beforeEach(() => { Object.keys(store).forEach(k => delete store[k]); });

describe('offline: drafts still capture changes (non-variant)', () => {
  it('a plain edit is dirty and is saved as the product\'s single edit draft — no connectivity involved', async () => {
    const saved = editingToState(product({ has_variants: false }), [], C);
    const edited = { ...saved, price: '6 000' };
    expect(isEditDirty(edited, saved)).toBe(true);
    await saveQuickAddDraft('biz', editDraftId('prod-1'), edited, { productId: 'prod-1' });
    const list = await listQuickAddDrafts('biz');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'edit-prod-1', kind: 'edit', productId: 'prod-1' });
    expect(list[0].state.price).toBe('6 000');
  });
  it('the draft code never consults the connection', () => {
    expect(read('lib/quickAddDraft.ts')).not.toMatch(/connectivity|isKnownOffline|NetInfo/);
    const sheet = read('src/components/QuickAddProductSheet.tsx');
    const autosave = sheet.slice(sheet.indexOf('// Edit drafts: unsaved changes'), sheet.indexOf('const handleClose'));
    expect(autosave).not.toMatch(/offline/);
  });
});

describe('a draft containing variants, reopened offline', () => {
  it('keeps every model, its quantity and its price intact through save → list (nothing dropped on the way)', async () => {
    const base = editingToState(product(), variants, C);
    let s = patchVariant(base, 'v-m', { name: 'M2', price: '5 500' });
    s = addVariant(s);
    s = patchVariant(s, s.variants[2].key, { name: 'XL', qty: '7' });
    expect(isEditDirty(s, base)).toBe(true);
    await saveQuickAddDraft('biz', editDraftId('prod-1'), s, { productId: 'prod-1' });
    const back = (await listQuickAddDrafts('biz'))[0].state;
    expect(back.models).toBe(true);
    expect(back.variants.map(v => [v.name, v.qty, v.price])).toEqual([['M2', '4', '5 500'], ['L', '2', '5 000'], ['XL', '7', '']]);
    expect(back.variants[0].locked).toBe(true);        // existing models keep their locked stock
  });
  it('edit mode offline: models switch disabled with the exact copy, rows non-interactive — and the state is NOT reset', () => {
    const sheet = read('src/components/QuickAddProductSheet.tsx');
    expect(sheet).toContain('Modèles : connexion requise');
    expect(sheet).toMatch(/pointerEvents=\{offline \? 'none' : 'auto'\}/);
    // the force-off effect is add-mode only, so an edit draft's models are never switched off or wiped
    expect(sheet).toMatch(/if \(offline && !isEdit && s\.models\) setS\(prev => setModels\(prev, false\)\)/);
  });
  it('add mode offline: Modèles are never offered and a draft that had them is switched off with its rows KEPT (not wiped)', () => {
    const sheet = read('src/components/QuickAddProductSheet.tsx');
    expect(sheet).toMatch(/\) : !offline && \(/);
    // behaviour, not a comment: switching Modèles off (what the offline force-off does) keeps the rows
    const on = setModels({ ...EMPTY_QUICK_ADD, name: 'T', price: '5 000', qty: '3' }, true);
    const filled = patchVariant(on, on.variants[0].key, { name: 'M', qty: '3' });
    const off = setModels(filled, false);
    expect(off.models).toBe(false);
    expect(off.variants.map(v => [v.name, v.qty])).toEqual([['M', '3']]);
    expect(off.qty).toBe('3');
    expect(setModels(off, true).variants.map(v => v.name)).toEqual(['M']);   // and back online they return
  });
});

describe('saving an edit offline never drops the unsaved model changes', () => {
  const hook = read('src/components/products/useProductSheets.tsx');
  const sheet = read('src/components/QuickAddProductSheet.tsx');
  it('the handler never calls the models RPC offline and says so (exact copy), reporting modelsPending', () => {
    const edit = hook.slice(hook.indexOf('const handleEdit'), hook.indexOf('// Archive / restore live in the edit sheet'));
    expect(edit).toContain('isKnownOffline() ? false : await upsertVariants(');
    expect(edit).toContain('modelsNotSavedAlert()');
    expect(edit).toContain('return { ok: true, modelsPending: true }');
    expect(read('src/utils/failureCopy.ts')).toContain('Produit enregistré. Modèles non enregistrés — connexion requise.');
  });
  it('the sheet then KEEPS the edit draft, re-saved with exactly what is on screen; a fully saved edit still removes it', () => {
    const submit = sheet.slice(sheet.indexOf('const submit = async'), sheet.indexOf('const collapsedName'));
    expect(submit).toMatch(/if \(res\.modelsPending\) \{[\s\S]*?saveQuickAddDraft\(businessId, editDraftId\(editing\.id\), sRef\.current, \{ productId: editing\.id \}\)[\s\S]*?\} else \{[\s\S]*?removeQuickAddDraft\(businessId, editDraftId\(editing\.id\)\)/);
    // and nothing re-deletes or overwrites it afterwards
    expect(submit).toContain('editSubmitted.current = true');
  });
  it('the kept draft round-trips and is removable via ×', async () => {
    const base = editingToState(product(), variants, C);
    const edited = patchVariant(base, 'v-l', { qty: '9' });
    await saveQuickAddDraft('biz', editDraftId('prod-1'), edited, { productId: 'prod-1' });
    expect((await listQuickAddDrafts('biz'))[0].state.variants[1].qty).toBe('9');
    await removeQuickAddDraft('biz', editDraftId('prod-1'));
    expect(await listQuickAddDrafts('biz')).toEqual([]);
  });
});
