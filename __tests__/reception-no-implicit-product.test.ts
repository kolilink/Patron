// One flow to add a product: a delivery line NEVER becomes a product at confirm. It is linked to an
// existing product, or to one created through the QuickAddProductSheet (delivery mode).
//
// Pure rules are tested for real. This repo has no component-render harness, so the screen/sheet
// wiring is pinned at source level — that pins the contract, it does not replace a tap-through.

import fs from 'fs';
import path from 'path';
import { isUnlinkedNamedLine, linkedLinePatch, unlinkedNamedLines } from '@/src/utils/receptionLink';
import { EMPTY_QUICK_ADD, addVariant, patchVariant, priceValid, setModels, toQuickAddPayload, type QuickAddState } from '@/src/utils/quickAddProduct';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const C = 'GNF';
const st = (over: Partial<QuickAddState> = {}): QuickAddState => ({ ...EMPTY_QUICK_ADD, ...over });

describe('an unlinked named line is never a product', () => {
  it('flags a typed name with no product_id, and only that', () => {
    expect(isUnlinkedNamedLine({ name: 'Savon', product_id: null })).toBe(true);
    expect(isUnlinkedNamedLine({ name: '  ', product_id: null })).toBe(false); // empty name is a different issue
    expect(isUnlinkedNamedLine({ name: 'Savon', product_id: 'p1' })).toBe(false);
    expect(unlinkedNamedLines([
      { localId: 'a', name: 'Savon', product_id: null },
      { localId: 'b', name: 'Riz', product_id: 'p1' },
      { localId: 'c', name: '', product_id: null },
    ]).map(l => l.localId)).toEqual(['a']);
  });
});

describe('the sheet in delivery mode creates the product with NO stock and NO cost', () => {
  it('stock and cost are booked by the delivery at confirm — creating with them would count twice', () => {
    const p = toQuickAddPayload(st({ name: 'Savon', price: '1 500', qty: '12', purchasePrice: '900' }), C, undefined, { delivery: true });
    expect(p.data).toMatchObject({ name: 'Savon', sale_price: 1500, initial_stock: 0, cost_price: 0 });
    expect(p.deliveryQty).toBe(12);
    expect(p.hasVariants).toBe(false);
  });
  it('ordinary add mode is unchanged (stock and cost ride the create)', () => {
    const p = toQuickAddPayload(st({ name: 'Savon', price: '1 500', qty: '12', purchasePrice: '900' }), C);
    expect(p.data).toMatchObject({ initial_stock: 12, cost_price: 900 });
    expect(p.deliveryQty).toBeUndefined();
  });
  it('with Modèles: models carry no stock/cost, and the typed per-model quantities come back as splits', () => {
    let s = setModels(st({ name: 'T-shirt', price: '5 000', qty: '10' }), true);
    s = patchVariant(s, s.variants[0].key, { name: 'M', qty: '6' });
    s = addVariant(s);
    s = patchVariant(s, s.variants[1].key, { name: 'L', qty: '4' });
    const p = toQuickAddPayload(s, C, undefined, { delivery: true });
    expect(p.hasVariants).toBe(true);
    expect(p.data.initial_stock).toBe(0);
    expect(p.variants.every(v => v.stock_qty === 0 && v.cost_price === 0)).toBe(true);
    expect(p.deliveryQty).toBe(10);
    expect(p.deliverySplits).toEqual([{ name: 'M', qty: 6 }, { name: 'L', qty: 4 }]);
  });
  it('"Je vends à" is required in delivery mode (a price-less name-only add is for the rapid loop only)', () => {
    expect(priceValid(st({ name: 'Savon' }), C)).toBe(false);
    expect(priceValid(st({ name: 'Savon', price: '1 500' }), C)).toBe(true);
    const sheet = read('src/components/QuickAddProductSheet.tsx');
    expect(sheet).toContain('(isDelivery && !priceValid(s, currency))');
  });
});

describe('Ajouter links the line', () => {
  it('product_id set, quantity from the sheet, sale price booked (touched) — unit cost is not in the patch, so the line keeps it', () => {
    const payload = toQuickAddPayload(st({ name: 'Savon', price: '1 500', qty: '12' }), C, undefined, { delivery: true });
    const patch = linkedLinePatch({ productId: 'new-1', payload, createdVariants: [], fallbackQty: '8', currency: C });
    expect(patch).toMatchObject({
      product_id: 'new-1', name: 'Savon', hasVariants: false, variantSplits: null, qty: '12',
      salePriceCents: 150000, salePriceTouched: true,
    });
    expect(patch.salePriceInput.replace(/\s| /g, '')).toBe('1500');
    expect(Object.keys(patch)).not.toContain('unitCost');
  });
  it('falls back to the line\'s own quantity when the sheet gives none', () => {
    const payload = toQuickAddPayload(st({ name: 'Savon', price: '100', qty: '' }), C, undefined, { delivery: true });
    expect(linkedLinePatch({ productId: 'n', payload, createdVariants: [], fallbackQty: '8', currency: C }).qty).toBe('8');
  });
  it('with Modèles the line goes through the per-model split, using the created models\' ids', () => {
    let s = setModels(st({ name: 'T-shirt', price: '5 000' }), true);
    s = patchVariant(s, s.variants[0].key, { name: 'M', qty: '6' });
    s = addVariant(s);
    s = patchVariant(s, s.variants[1].key, { name: 'L', qty: '4' });
    const payload = toQuickAddPayload(s, C, undefined, { delivery: true });
    const patch = linkedLinePatch({
      productId: 'n', payload, fallbackQty: '1', currency: C,
      createdVariants: [{ id: 'v-m', name: 'M' }, { id: 'v-l', name: 'L' }],
    });
    expect(patch.hasVariants).toBe(true);
    expect(patch.variantSplits).toEqual([{ variant_id: 'v-m', name: 'M', qty: '6' }, { variant_id: 'v-l', name: 'L', qty: '4' }]);
    expect(patch.qty).toBe('10');
  });
  it('models that could not be created degrade to a plain linked product, never a dangling split', () => {
    let s = setModels(st({ name: 'T', price: '5 000', qty: '3' }), true);
    s = patchVariant(s, s.variants[0].key, { name: 'M', qty: '3' });
    const payload = toQuickAddPayload(s, C, undefined, { delivery: true });
    const patch = linkedLinePatch({ productId: 'n', payload, createdVariants: [], fallbackQty: '3', currency: C });
    expect(patch.hasVariants).toBe(false);
    expect(patch.variantSplits).toBeNull();
  });
});

describe('reception screen wiring', () => {
  const rec = read('app/(app)/fournisseurs/reception.tsx');
  it('the implicit-create path and the inline "dismiss match → create" behaviour are gone', () => {
    expect(rec).not.toMatch(/newProductCount/);
    expect(rec).not.toMatch(/dismissedMatchId/);
    expect(rec).not.toMatch(/\+\$\{newProduct/);
  });
  it('"Nouveau produit" (match banner and the no-match resolve row) opens the sheet with the line\'s name and quantity', () => {
    expect(rec.match(/onCreateProduct\(line\)/g)?.length).toBe(2);
    expect(rec).toMatch(/setSheetTarget\(\{ localId: line\.localId, name: line\.name\.trim\(\), qty: line\.qty \}\)/);
    expect(rec).toMatch(/delivery=\{sheetTarget \? \{ name: sheetTarget\.name, qty: sheetTarget\.qty \} : null\}/);
  });
  it('the existing-product link path is unchanged ("Ajouter au stock" still links the match)', () => {
    expect(rec).toMatch(/onPress=\{\(\) => onLinkProduct\(line\.localId, match\)\}/);
    expect(rec).toContain('Ajouter au stock');
    expect(rec).toContain('existe déjà');
  });
  it('Annuler only closes the sheet: the line stays an unlinked named draft', () => {
    expect(rec).toMatch(/<QuickAddProductSheet[\s\S]*?onClose=\{\(\) => setSheetOpen\(false\)\}/);
    const create = rec.slice(rec.indexOf('const createForLine'), rec.indexOf('const addLine'));
    // the line is only touched after the product was really created
    expect(create.indexOf('updateLine(')).toBeGreaterThan(create.indexOf('createProduct('));
  });
  it('creation is phone-first through createProduct with a client id the line links to', () => {
    const create = rec.slice(rec.indexOf('const createForLine'), rec.indexOf('const addLine'));
    expect(create).toContain('const productId = generateId()');
    expect(create).toContain('createProduct(businessId, userId, { ...payload.data, id: productId })');
    expect(read('stores/products.ts')).toContain('const productId = data.id ?? generateId();');
  });
  it('confirm BLOCKS on an unlinked named line, with an inline resolve action — never a silent create', () => {
    const first = rec.slice(rec.indexOf('function firstIssue'), rec.indexOf('const remainingCount'));
    expect(first).toContain("kind: 'unlinked'");
    const confirm = rec.slice(rec.indexOf('const handleConfirm'), rec.indexOf('const rpcLines'));
    expect(confirm).toContain('draft.lines.find(isUnlinkedNamedLine)');
    expect(confirm).toMatch(/setStep\('quoi'\);[\s\S]*?return;/);
    // inline resolve actions on the line
    expect(rec).toContain('Pas encore un produit.');
    expect(rec).toContain('Choisir un produit');
    expect(rec).toMatch(/onPickProduct=\{line => setPickerLineId\(line\.localId\)\}/);
    expect(rec).toMatch(/n'est pas encore un produit/);
  });
  it('no line without a product_id is ever sent to the server', () => {
    const body = rec.slice(rec.indexOf('const handleConfirm'), rec.indexOf('setReceptionKey(key)'));
    expect(body).toMatch(/const unlinked = draft\.lines\.find\(isUnlinkedNamedLine\)/);
  });
});

describe('sheet in delivery mode', () => {
  const sheet = read('src/components/QuickAddProductSheet.tsx');
  it('no "Plus d\'informations" (the line owns unit cost), no drafts, closes on Ajouter instead of looping', () => {
    expect(sheet).toMatch(/\{!isDelivery && \(\s*\n\s*<Pressable onPress=\{toggleExpanded\}/);
    expect(sheet).toContain('{expanded && !isDelivery && (');
    expect(sheet).toContain('const noDraft = isEdit || isDelivery;');
    expect(sheet).toContain('if (isEdit || isDelivery) return;');
  });
  it('Modèles are offered only when online (the models call is online-only)', () => {
    // offline: the toggle is never offered in add / delivery (the guard now covers every add flow)
    expect(sheet).toContain(') : !offline && (');
  });
});
