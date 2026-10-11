// QuickAddProductSheet logic: validation, Modèles conversion, derived total,
// coût réel (fee spreading), autocomplete, and the offline create path.

const enqueued: { op: string; payload: any }[] = [];
const rpcCalls: string[] = [];

jest.mock('@/lib/db', () => ({
  ...jest.requireActual('@/lib/db'),
  enqueue: async (op: string, payload: any) => { enqueued.push({ op, payload }); },
  // the real outbox read, fed by what enqueue captured (entity_type 'produit' as db.ts stamps it)
  getAllQueueItemsForOverlay: async () => ({
    ok: enqueued.map((q, i) => ({ id: i + 1, operation: q.op, payload: JSON.stringify(q.payload), status: 'pending', entity_type: 'produit' })),
    corrupt: [],
  }),
  getProductCache: async () => [],
  getQueueCount: async () => enqueued.length,
}));
jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: async (fn: string) => { rpcCalls.push(fn); throw new Error('network down'); },
    from: () => { rpcCalls.push('from'); throw new Error('network down'); },
    auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })) },
  },
}));
jest.mock('@/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/lib/posthog', () => ({ posthog: null }));
jest.mock('@/src/utils/notifications', () => ({ notifyEvent: jest.fn(), resolveSellerDisplayName: jest.fn() }));

import {
  EMPTY_QUICK_ADD, addVariant, afterAdd, canSubmit, isBlankDraft, needsSalePrice, computeCostLine, derivedTotalPieces, needsPurchasePrice,
  patchVariant, removeVariant, resolvedVariantPrice, setModels, suggestProducts,
  toQuickAddPayload, validateQuickAdd, type QuickAddState,
} from '@/src/utils/quickAddProduct';
import { formatAmount as realFormatAmount } from '@/src/utils/format';
import { useProductStore } from '@/stores/products';
import { drainQueue } from '@/lib/sync';

const C = 'GNF';
const st = (over: Partial<QuickAddState> = {}): QuickAddState => ({ ...EMPTY_QUICK_ADD, ...over });
const prod = (id: string, name: string, over: any = {}) => ({ id, name, sale_price: 1000, cost_price: 500, ...over } as any);

describe('validation: ONLY an empty name blocks', () => {
  it('requires a name', () => {
    expect(validateQuickAdd(st({ price: '1 000' }), C)).toBe('Indiquez le nom');
    expect(canSubmit(st({ price: '1 000' }))).toBe(false);
    expect(canSubmit(st({ name: '   ' }))).toBe(false);
  });
  it('a name alone is enough — no price, no quantity, nothing else blocks', () => {
    expect(validateQuickAdd(st({ name: 'Riz' }), C)).toBeNull();
    expect(canSubmit(st({ name: 'Riz' }))).toBe(true);
    expect(canSubmit(st({ name: 'Riz', price: '0', qty: '' }))).toBe(true);
  });
  it('with Modèles, an unnamed row does not block', () => {
    const s = setModels(st({ name: 'T-shirt', price: '5 000' }), true);
    expect(canSubmit(s)).toBe(true);
  });
});

describe('Modèles toggle conversion', () => {
  it('ON: single qty becomes the first row; its price follows the starting price', () => {
    const on = setModels(st({ name: 'T', price: '5 000', qty: '12' }), true);
    expect(on.models).toBe(true);
    expect(on.variants).toHaveLength(1);
    expect(on.variants[0].qty).toBe('12');
    expect(on.variants[0].touched).toBe(false);
    expect(resolvedVariantPrice(on.variants[0], on, C)).toBe(5000);
  });
  it('OFF: the derived total becomes the single qty (nothing lost)', () => {
    let s = setModels(st({ name: 'T', price: '5 000', qty: '1' }), true);
    s = patchVariant(s, s.variants[0].key, { qty: '4' });
    s = addVariant(s);
    s = patchVariant(s, s.variants[1].key, { qty: '6' });
    const off = setModels(s, false);
    expect(off.qty).toBe('10');
    expect(off.price).toBe('5 000');
  });
  it('OFF then ON again restores the rows', () => {
    let s = setModels(st({ price: '100' }), true);
    s = patchVariant(s, s.variants[0].key, { name: 'M', qty: '3' });
    const back = setModels(setModels(s, false), true);
    expect(back.variants[0]).toMatchObject({ name: 'M', qty: '3' });
  });
});

describe('prefilled vs edited rows', () => {
  it('untouched rows follow the starting price live; typing marks the row touched and it stops following', () => {
    let s = setModels(st({ price: '5 000' }), true);
    s = addVariant(s);
    const [a, b] = s.variants.map(v => v.key);
    s = patchVariant(s, a, { price: '7 000' });
    s = { ...s, price: '6 000' };
    const [ra, rb] = s.variants;
    expect(ra.touched).toBe(true);
    expect(resolvedVariantPrice(ra, s, C)).toBe(7000);
    expect(rb.touched).toBe(false);
    expect(resolvedVariantPrice(rb, s, C)).toBe(6000);
    expect(b).toBe(rb.key);
  });
  it('editing name/qty does not mark the price touched', () => {
    let s = setModels(st({ price: '100' }), true);
    s = patchVariant(s, s.variants[0].key, { name: 'M', qty: '2' });
    expect(s.variants[0].touched).toBe(false);
  });
});

describe('derived total', () => {
  it('sums row quantities live and ignores junk', () => {
    let s = setModels(st({ price: '1' }), true);
    s = addVariant(addVariant(s));
    s = patchVariant(s, s.variants[0].key, { qty: '3' });
    s = patchVariant(s, s.variants[1].key, { qty: '4' });
    s = patchVariant(s, s.variants[2].key, { qty: '' });
    expect(derivedTotalPieces(s.variants)).toBe(7);
    s = removeVariant(s, s.variants[1].key);
    expect(derivedTotalPieces(s.variants)).toBe(3);
  });
});

describe('coût réel par pièce', () => {
  const f = (n: number) => realFormatAmount(n, C).split(' ').join(' ');
  it('is not computable without a purchase price or fees', () => {
    expect(computeCostLine(st({ price: '1 000' }), C)).toBeNull();
  });
  it('spreads fees over the pieces: 3 × 1 000 + 3 000 fees over 3 = 2 000/piece', () => {
    const c = computeCostLine(st({ price: '3 000', qty: '3', purchasePrice: '1 000', fees: '3 000' }), C)!;
    expect(c.unitCost).toBe(2000);
    expect(f(c.profit!)).toBe('1 000 GNF');
  });
  it('with Modèles the divisor is the derived total', () => {
    let s = setModels(st({ price: '3 000', purchasePrice: '1 000', fees: '3 000' }), true);
    s = patchVariant(s, s.variants[0].key, { qty: '1' });
    s = addVariant(s);
    s = patchVariant(s, s.variants[1].key, { qty: '2' });
    expect(computeCostLine(s, C)!.unitCost).toBe(2000);
  });
  it('profit is null until a sale price exists; a loss is negative', () => {
    expect(computeCostLine(st({ purchasePrice: '500', qty: '1' }), C)!.profit).toBeNull();
    expect(computeCostLine(st({ price: '300', purchasePrice: '500', qty: '1' }), C)!.profit).toBe(-200);
  });
});

describe('payload', () => {
  it('draft: no purchase price → cost 0, sellable at once, qty default 1', () => {
    const p = toQuickAddPayload(st({ name: ' Riz ', price: '5 000' }), C);
    expect(p.data).toMatchObject({ name: 'Riz', cost_price: 0, sale_price: 5000, initial_stock: 1, unit: 'pcs', reorder_level: 0, supplier_id: null });
    expect(p.hasVariants).toBe(false);
  });
  it('name-only: sale_price 0 (column is NOT NULL → 0 means "Prix à fixer"), quantity 1, no variants', () => {
    const p = toQuickAddPayload(st({ name: 'Savon' }), C);
    expect(p.data).toMatchObject({ name: 'Savon', sale_price: 0, cost_price: 0, initial_stock: 1 });
    expect(p.hasVariants).toBe(false);
    expect(needsSalePrice({ sale_price: p.data.sale_price })).toBe(true);
    expect(needsSalePrice({ sale_price: 5000 })).toBe(false);
  });
  it('Modèles with only unnamed rows degrades to a plain product; unnamed rows are dropped', () => {
    const unnamed = setModels(st({ name: 'T', qty: '3' }), true);
    const plain = toQuickAddPayload(unnamed, C);
    expect(plain.hasVariants).toBe(false);
    expect(plain.variants).toEqual([]);
    let s = addVariant(patchVariant(unnamed, unnamed.variants[0].key, { name: 'M', qty: '2' }));
    s = patchVariant(s, s.variants[1].key, { qty: '9' }); // no name
    const p = toQuickAddPayload(s, C);
    expect(p.hasVariants).toBe(true);
    expect(p.variants.map(v => v.name)).toEqual(['M']);
  });
  it('no stock/seuil field: reorder_level is always 0', () => {
    expect(toQuickAddPayload(st({ name: 'a', price: '1' }), C).data.reorder_level).toBe(0);
  });
  it('Modèles: parent stock 0, rows carry stock + resolved prices', () => {
    let s = setModels(st({ name: 'T', price: '5 000' }), true);
    s = patchVariant(s, s.variants[0].key, { name: 'M', qty: '4' });
    s = addVariant(s);
    s = patchVariant(s, s.variants[1].key, { name: 'L', qty: '2', price: '6 000' });
    const p = toQuickAddPayload(s, C);
    expect(p.data.initial_stock).toBe(0);
    expect(p.variants).toEqual([
      expect.objectContaining({ name: 'M', stock_qty: 4, sale_price: 5000 }),
      expect.objectContaining({ name: 'L', stock_qty: 2, sale_price: 6000 }),
    ]);
  });
  it('supplier + fees flow into cost_price', () => {
    const p = toQuickAddPayload(st({ name: 'a', price: '3 000', qty: '3', purchasePrice: '1 000', fees: '3 000', supplierId: 'sup1' }), C);
    expect(p.data.cost_price).toBe(2000);
    expect(p.data.supplier_id).toBe('sup1');
  });
});

describe('autocomplete', () => {
  const list = [prod('1', 'Riz parfumé'), prod('2', 'Huile'), prod('3', 'Fromage riz'), prod('4', 'Éponge')];
  it('matches case/accent-insensitively, prefix first', () => {
    expect(suggestProducts('riz', list).map(p => p.id)).toEqual(['1', '3']);
    expect(suggestProducts('epon', list).map(p => p.id)).toEqual(['4']);
  });
  it('needs 2+ characters and returns nothing for no match', () => {
    expect(suggestProducts('r', list)).toEqual([]);
    expect(suggestProducts('zzz', list)).toEqual([]);
  });
  it('select-existing vs create: a typed name with no match yields no suggestions (create path)', () => {
    expect(suggestProducts('Savon', list)).toHaveLength(0);
  });
});

describe('Prix à fixer', () => {
  it('flags only products without a purchase price', () => {
    expect(needsPurchasePrice({ cost_price: 0 })).toBe(true);
    expect(needsPurchasePrice({ cost_price: 1200 })).toBe(false);
  });
});

describe('offline create (phone-first, same UUID)', () => {
  beforeEach(() => { enqueued.length = 0; rpcCalls.length = 0; });

  it('writes to the outbox only, product is visible locally, no network call', async () => {
    const payload = toQuickAddPayload(st({ name: 'Riz', price: '5 000', qty: '2' }), C);
    const ok = await useProductStore.getState().createProduct('biz', 'user', payload.data);
    expect(ok).toBe(true);
    expect(rpcCalls).toEqual([]);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].op).toBe('create_product');
    const row = enqueued[0].payload.product;
    expect(row).toMatchObject({ name: 'Riz', sale_price: 500000, stock_qty: 2, cost_price: 0 });
    expect(enqueued[0].payload.stockMove).toMatchObject({ product_id: row.id, qty: 2 });
    // immediately visible in the grid's source list, under the same id the outbox will send
    expect(useProductStore.getState().products.some(p => p.id === row.id && p.name === 'Riz')).toBe(true);
  });
});

describe('name-only create', () => {
  beforeEach(() => { enqueued.length = 0; rpcCalls.length = 0; });
  it('goes through the outbox with sale_price 0 and lands in the grid as a "Prix à fixer" product', async () => {
    const payload = toQuickAddPayload(st({ name: 'Savon' }), C);
    expect(await useProductStore.getState().createProduct('biz', 'user', payload.data)).toBe(true);
    expect(rpcCalls).toEqual([]);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].payload.product).toMatchObject({ name: 'Savon', sale_price: 0 });
    const shown = useProductStore.getState().products.find(p => p.name === 'Savon');
    expect(shown).toBeTruthy();
    expect(needsSalePrice(shown!)).toBe(true);
  });
});

describe('offline create drains with the same UUID', () => {
  it('create_product replays the queued product id to create_product_with_stock', async () => {
    // Drain is covered in depth by idempotent-replay-drain.test.ts; here we
    // assert the payload this flow queues is exactly what that RPC receives.
    const id = 'fixed-uuid';
    const sent: any[] = [];
    jest.resetModules();
    jest.doMock('@/lib/db', () => ({
      ...jest.requireActual('@/lib/db'),
      getPendingOpsForDrain: async () => ({ ok: [{ id: 1, operation: 'create_product', payload: JSON.stringify({ product: { id, name: 'Riz' }, stockMove: null }), status: 'pending', attempts: 0 }], corrupt: [] }),
      deleteQueueItem: async () => {},
      rescheduleOp: async () => {},
      markOpPermanentlyFailed: async () => {},
      markOpCorrupt: async () => {},
      getPendingSupplierKeys: async () => new Set(),
    }));
    jest.doMock('@/lib/supabase', () => ({
      supabase: { rpc: async (fn: string, a: any) => { sent.push({ fn, a }); return { data: null, error: null }; }, from: () => ({}),
        auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })) } },
    }));
    const { drainQueue: drain } = require('@/lib/sync');
    expect((await drain()).synced).toBe(1);
    expect(sent[0].fn).toBe('create_product_with_stock');
    expect(JSON.stringify(sent[0].a)).toContain(id);
  });
});

// keep the import used so the module graph matches production
void drainQueue;

describe('between adds (the rapid loop)', () => {
  it('quantity is sticky; price, name, fees, supplier are cleared; Modèles resets to off', () => {
    let s = st({ name: 'Riz', price: '5 000', qty: '7', purchasePrice: '1 000', fees: '500', supplierId: 'sup' });
    s = setModels(s, true);
    const next = afterAdd(s);
    expect(next.qty).toBe('7');
    expect(next).toMatchObject({ name: '', price: '', purchasePrice: '', fees: '', supplierId: '', models: false, variants: [] });
  });
  it('the price is NEVER carried over, however many adds', () => {
    let s = st({ name: 'A', price: '9 999', qty: '2' });
    for (let i = 0; i < 3; i++) s = afterAdd({ ...s, name: 'N' + i, price: '1 234' });
    expect(s.price).toBe('');
  });
});

describe('À compléter drafts (local only, max 3)', () => {
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

  it('a half-filled sheet is kept and listed newest first', async () => {
    const d = load();
    await d.saveQuickAddDraft('biz', 'a', st({ name: 'Riz', price: '2 500' }));
    await new Promise(r => setTimeout(r, 2));
    await d.saveQuickAddDraft('biz', 'b', st({ name: 'Huile' }));
    expect((await d.listQuickAddDrafts('biz')).map(x => x.id)).toEqual(['b', 'a']);
  });
  it('saving the same id again updates that draft instead of adding another', async () => {
    const d = load();
    await d.saveQuickAddDraft('biz', 'a', st({ name: 'Ri' }));
    await d.saveQuickAddDraft('biz', 'a', st({ name: 'Riz' }));
    const l = await d.listQuickAddDrafts('biz');
    expect(l).toHaveLength(1);
    expect(l[0].state.name).toBe('Riz');
  });
  it('holds at most 3: the 4th pushes the oldest out', async () => {
    const d = load();
    for (const [i, n] of ['A', 'B', 'C', 'D'].entries()) {
      await d.saveQuickAddDraft('biz', n, st({ name: n }));
      await new Promise(r => setTimeout(r, 2 + i));
    }
    const l = await d.listQuickAddDrafts('biz');
    expect(l.map(x => x.state.name)).toEqual(['D', 'C', 'B']);
    expect(d.MAX_DRAFTS).toBe(3);
  });
  it('survives an app restart (fresh module instance reads the same persisted store)', async () => {
    await load().saveQuickAddDraft('biz', 'a', st({ name: 'Sucre', price: '1 000' }));
    expect((await load().listQuickAddDrafts('biz'))[0].state).toMatchObject({ name: 'Sucre' });
  });
  it('deleting a draft removes only that one', async () => {
    const d = load();
    await d.saveQuickAddDraft('biz', 'a', st({ name: 'A' }));
    await d.saveQuickAddDraft('biz', 'b', st({ name: 'B' }));
    await d.removeQuickAddDraft('biz', 'a');
    expect((await d.listQuickAddDrafts('biz')).map(x => x.id)).toEqual(['b']);
  });
  it('a blank sheet removes its own draft (quantity alone is not a draft)', async () => {
    const d = load();
    await d.saveQuickAddDraft('biz', 'a', st({ name: 'Sucre' }));
    await d.saveQuickAddDraft('biz', 'a', st({ qty: '9' }));
    expect(isBlankDraft(st({ qty: '9' }))).toBe(true);
    expect(await d.listQuickAddDrafts('biz')).toEqual([]);
  });
  it('per business; a corrupt blob is no drafts', async () => {
    const d = load();
    await d.saveQuickAddDraft('a', 'x', st({ name: 'X' }));
    expect(await d.listQuickAddDrafts('b')).toEqual([]);
    store['quick_add_drafts_a'] = '{not json';
    expect(await d.listQuickAddDrafts('a')).toEqual([]);
  });
  it('folds in the single draft written by the previous build, once', async () => {
    const d = load();
    store['quick_add_draft_biz'] = JSON.stringify(st({ name: 'Ancien', price: '5 000' }));
    const l = await d.listQuickAddDrafts('biz');
    expect(l.map(x => x.state.name)).toEqual(['Ancien']);
    expect(store['quick_add_draft_biz']).toBe('');
    expect((await d.listQuickAddDrafts('biz'))).toHaveLength(1);
  });
  it('a draft never touches the outbox or the network', async () => {
    const d = load();
    await d.saveQuickAddDraft('biz', 'a', st({ name: 'Sucre', price: '1' }));
    await d.listQuickAddDrafts('biz');
    await d.removeQuickAddDraft('biz', 'a');
    expect(outbox).toEqual([]);
    expect(require('fs').readFileSync(require('path').join(__dirname, '../lib/quickAddDraft.ts'), 'utf8')).not.toMatch(/enqueue|supabase/);
  });
});

const sheetSrc = () => require('fs').readFileSync(require('path').join(__dirname, '../src/components/QuickAddProductSheet.tsx'), 'utf8') as string;

describe('sheet chrome', () => {
  it('no visible keyboard accessory: only the zero-height silent one that suppresses the OS Next/Done pill', () => {
    const src = sheetSrc();
    expect(src).not.toMatch(/<InputAccessoryView|Suivant|Terminé/);
    expect(src).toContain('<SilentKeyboardAccessory');
  });
  it('number/decimal pads are linked to the silent accessory', () => {
    const src = sheetSrc();
    expect(src).toContain('inputAccessoryViewID={IOS_SILENT}');
    expect(src).toContain('inputAccessoryViewID={SILENT_ID}');
  });
  it('no hairline row separators', () => {
    expect(sheetSrc()).not.toMatch(/borderBottomWidth|borderTopWidth/);
  });
  it('taps outside a field dismiss the keyboard while fields stay directly tappable', () => {
    expect(sheetSrc()).toContain('keyboardShouldPersistTaps="handled"');
  });
  it('no global LayoutAnimation (it animated the footer + keyboard padding and faded deleted rows over new ones)', () => {
    const src = sheetSrc();
    expect(src).not.toMatch(/LayoutAnimation|configureLayoutNext/);
    expect(src).toContain('LinearTransition');
  });
  it('footer: exactly one action button, in the gesture sheet, keyboard-aware inset', () => {
    const src = sheetSrc();
    expect((src.match(/<Button label=/g) || []).length).toBe(1);
    expect(src).toContain('<GestureSheet');
    expect(src).not.toContain('<FormSheet');
    expect(src).toContain('useKeyboardVisible');
  });
  it('opens FRESH (or with the draft/product it is handed) — no auto-restore of a previous draft', () => {
    const src = sheetSrc();
    expect(src).toContain('setS({ ...EMPTY_QUICK_ADD, name: initialName ?? \'\' })');
    expect(src).not.toMatch(/loadQuickAddDraft|Brouillon repris/);
  });
});

describe('footer background', () => {
  it('the footer container is transparent: no background colour, border or shadow behind Ajouter', () => {
    const src = sheetSrc();
    const m = src.match(/footer: \{[^}]*\}/);
    expect(m).not.toBeNull();
    expect(m![0]).toContain("backgroundColor: 'transparent'");
    expect(m![0]).not.toMatch(/p\.background|p\.surface|shadow|border/);
  });
});

describe('labels, currency suffix, variants', () => {
  it('labels carry no currency, parenthetical or "unitaire"', () => {
    const src = sheetSrc();
    expect(src).toContain('>Je vends à<');
    expect(src).toContain('>Prix d\'achat<');
    expect(src).toContain('>Frais<');
    expect(src).not.toMatch(/unitaire|transport, etc|· \$\{currency\}/);
  });
  it('currency is a lowercase suffix that exists only once digits exist; no placeholder on money fields', () => {
    const src = sheetSrc();
    expect(src).toContain('currency.toLowerCase()');
    expect(src).toContain("const has = typeof value === 'string' && value.length > 0");
    const blocks = src.match(/<MoneyInput\b[\s\S]*?\/>/g) as string[];
    expect(blocks.length).toBe(4);
    blocks.forEach(b => expect(b).not.toMatch(/placeholder=/));
  });
  it('every decimal-pad input is a MoneyInput; quantities never are', () => {
    const blocks = sheetSrc().match(/<(TextInput|MoneyInput)\b[\s\S]*?\/>/g) as string[];
    const decimal = blocks.filter(b => b.includes('decimal-pad'));
    expect(decimal.length).toBe(4);
    decimal.forEach(b => expect(b.startsWith('<MoneyInput')).toBe(true));
    blocks.filter(b => b.includes('number-pad')).forEach(b => expect(b.startsWith('<MoneyInput')).toBe(false));
  });
  it('quantity row has no unit; derived total has no unit', () => {
    const src = sheetSrc();
    expect(src).not.toMatch(/>pièces</);
    expect(src).toContain('Total : {totalPieces}');
    expect(src).not.toMatch(/pièce\{/);
  });
  it('variant name placeholder teaches one-model-per-row', () => {
    expect(sheetSrc()).toContain('placeholder="Ex : S"');
  });
});


describe('rapid loop wiring (source-level: this repo has no component-render harness)', () => {
  const src = () => sheetSrc();
  const read = (p: string) => require('fs').readFileSync(require('path').join(__dirname, '..', p), 'utf8') as string;
  const hook = () => read('src/components/products/useProductSheets.tsx');
  it('Ajouter is disabled only by an empty name', () => {
    expect(src()).toContain('disabled={!canSubmit(s)}');
  });
  it('after a successful add the sheet stays open: no onClose in the reset path, Nom is re-focused, fields fade-clear', () => {
    const body = src().slice(src().indexOf('const resetForNext'), src().indexOf('const submit = async'));
    expect(body).not.toContain('onClose');
    expect(body).toContain('nameRef.current?.focus()');
    expect(body).toContain('afterAdd(prev)');
    expect(body).toMatch(/toValue: 0, duration: 120/);
  });
  it('a failed add keeps everything typed (no reset); success ticks + toasts the product name; edit mode neither loops nor toasts', () => {
    const body = src().slice(src().indexOf('const submit = async'), src().indexOf('const collapsedName'));
    expect(body).toMatch(/if \(!res\.ok\) return;/);
    expect(body).toContain('haptics.success()');
    expect(body).toMatch(/if \(isEdit\) return;/);
    expect(body).toContain('showToast(name)');
    expect(src()).toContain('`${toastName} ajouté`');
  });
  it('the host adds via createProduct (outbox) without closing the sheet and pulses the new card', () => {
    const h = hook();
    const body = h.slice(h.indexOf('const handleAdd'), h.indexOf('const handleEdit'));
    expect(body).toContain('createProduct(businessId, userId, data)');
    expect(body).not.toContain('setAddOpen(false)');
    expect(body).toContain('setPulseId(created.id)');
  });
  it('a product with no sale price shows a tappable "Prix à fixer", never a 0 price', () => {
    const pm = read('src/components/products/ProductManager.tsx');
    expect(pm).toContain("needsSalePrice(product) ? '—' :");
    expect(pm).toContain('Prix à fixer');
    const vendre = read('app/(app)/(tabs)/vendre.tsx');
    expect(vendre).toContain('Prix à fixer');
  });
});
